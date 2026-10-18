// Refreshes the generated `prefixes:` list of each LiveKit relay-policy file
// (config/relay-policy/*.yaml, read by patches/livekit/0001-relay-policy.patch)
// from the prefixes its `asns:` currently announce, as RIPEstat reports them
// (https://stat.ripe.net/docs/data_api, data call announced-prefixes).
//
// Standard library only, so it runs without a module:
//
//	go run scripts/relay-policy-refresh/main.go [-check] [dir]
//
// The file layout it relies on, which config/relay-policy/README.md documents:
// `asns:` is a one-line flow list (`asns: [5384, 15802]`), and `prefixes:` is
// the LAST key of the file, followed only by its `  - <cidr>` items. Everything
// before `prefixes:` (comments, name, description, asns, manual_prefixes) is
// kept byte for byte. A file without ASNs is left alone.
//
// It refuses to write an empty list for a file that names ASNs: an API outage
// or a changed response must not silently switch a policy off. -check writes
// nothing and exits 1 when a file would change (for a scheduled drift check).
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

var asnsLine = regexp.MustCompile(`^asns:\s*\[([0-9,\s]*)\]\s*(#.*)?$`)

type announcedPrefixes struct {
	Status string `json:"status"`
	Data   struct {
		Prefixes []struct {
			Prefix string `json:"prefix"`
		} `json:"prefixes"`
	} `json:"data"`
}

func main() {
	check := flag.Bool("check", false, "write nothing; exit 1 if a file would change")
	flag.Parse()
	dir := "config/relay-policy"
	if flag.NArg() > 0 {
		dir = flag.Arg(0)
	}

	files, err := filepath.Glob(filepath.Join(dir, "*.yaml"))
	if err != nil || len(files) == 0 {
		fmt.Fprintf(os.Stderr, "relay-policy-refresh: no *.yaml in %s\n", dir)
		os.Exit(2)
	}
	sort.Strings(files)

	client := &http.Client{Timeout: 60 * time.Second}
	drift := false
	for _, file := range files {
		changed, err := refresh(client, file, *check)
		if err != nil {
			fmt.Fprintf(os.Stderr, "relay-policy-refresh: %s: %v\n", file, err)
			os.Exit(2)
		}
		drift = drift || changed
	}
	if *check && drift {
		os.Exit(1)
	}
}

func refresh(client *http.Client, file string, check bool) (bool, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return false, err
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")

	var asns []int
	cut := -1
	for i, line := range lines {
		if m := asnsLine.FindStringSubmatch(line); m != nil {
			for _, f := range strings.Split(m[1], ",") {
				if f = strings.TrimSpace(f); f == "" {
					continue
				}
				n, err := strconv.Atoi(f)
				if err != nil {
					return false, fmt.Errorf("asns: %w", err)
				}
				asns = append(asns, n)
			}
		} else if strings.HasPrefix(line, "asns:") {
			return false, errors.New("asns must be a one-line flow list, for example asns: [5384, 15802]")
		}
		if strings.HasPrefix(line, "prefixes:") {
			cut = i
		}
	}
	if len(asns) == 0 {
		fmt.Printf("%s: no asns, left alone\n", file)
		return false, nil
	}
	if cut < 0 {
		return false, errors.New("no prefixes: key")
	}
	for _, line := range lines[cut+1:] {
		t := strings.TrimSpace(line)
		if t != "" && !strings.HasPrefix(t, "- ") && !strings.HasPrefix(t, "#") {
			return false, fmt.Errorf("prefixes: must be the last key, found %q after it", line)
		}
	}

	var all []netip.Prefix
	for _, asn := range asns {
		got, err := fetch(client, asn)
		if err != nil {
			return false, fmt.Errorf("AS%d: %w", asn, err)
		}
		if len(got) == 0 {
			return false, fmt.Errorf("AS%d announces no prefix according to RIPEstat; refusing to drop it", asn)
		}
		all = append(all, got...)
	}
	prefixes := collapse(all)

	var b strings.Builder
	for _, line := range lines[:cut] {
		b.WriteString(line + "\n")
	}
	b.WriteString("prefixes:\n")
	for _, p := range prefixes {
		b.WriteString("  - " + p.String() + "\n")
	}
	out := b.String()

	changed := out != string(data)
	fmt.Printf("%s: %d ASNs, %d announced, %d after collapsing, changed=%v\n", file, len(asns), len(all), len(prefixes), changed)
	if changed && !check {
		// Write a sibling and rename it over the file: a running LiveKit may reload
		// the directory at any moment and must never read a half-written list. The
		// temporary name does not end in .yaml, so a reload never picks it up.
		tmp := file + ".tmp"
		if err := os.WriteFile(tmp, []byte(out), 0o644); err != nil {
			return false, err
		}
		if err := os.Rename(tmp, file); err != nil {
			os.Remove(tmp)
			return false, err
		}
	}
	return changed, nil
}

func fetch(client *http.Client, asn int) ([]netip.Prefix, error) {
	url := fmt.Sprintf("https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS%d&sourceapp=siwx-oidc-matrix-server", asn)
	resp, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var ap announcedPrefixes
	if err := json.NewDecoder(resp.Body).Decode(&ap); err != nil {
		return nil, err
	}
	if ap.Status != "ok" {
		return nil, fmt.Errorf("status %q", ap.Status)
	}
	var out []netip.Prefix
	for _, p := range ap.Data.Prefixes {
		prefix, err := netip.ParsePrefix(p.Prefix)
		if err != nil {
			return nil, err
		}
		out = append(out, prefix.Masked())
	}
	return out, nil
}

// collapse drops prefixes covered by another and merges sibling pairs into
// their parent until nothing changes; the result covers exactly the same
// addresses. IPv4 sorts before IPv6.
func collapse(in []netip.Prefix) []netip.Prefix {
	set := map[netip.Prefix]bool{}
	for _, p := range in {
		set[p.Masked()] = true
	}
	for {
		merged := false
		for p := range set {
			if p.Bits() == 0 {
				continue
			}
			parent := netip.PrefixFrom(p.Addr(), p.Bits()-1).Masked()
			lo := netip.PrefixFrom(parent.Addr(), p.Bits())
			hi, _ := lastAddr(parent).Prefix(p.Bits())
			if set[lo] && set[hi] {
				delete(set, lo)
				delete(set, hi)
				set[parent] = true
				merged = true
			}
		}
		if !merged {
			break
		}
	}

	out := make([]netip.Prefix, 0, len(set))
	for p := range set {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool {
		if c := out[i].Addr().Compare(out[j].Addr()); c != 0 {
			return c < 0
		}
		return out[i].Bits() < out[j].Bits()
	})
	// After sorting, a covered prefix follows the prefix that covers it.
	kept := out[:0]
	for _, p := range out {
		if len(kept) > 0 && kept[len(kept)-1].Contains(p.Addr()) && kept[len(kept)-1].Bits() <= p.Bits() {
			continue
		}
		kept = append(kept, p)
	}
	return kept
}

// lastAddr is the highest address of p.
func lastAddr(p netip.Prefix) netip.Addr {
	a := p.Masked().Addr().AsSlice()
	bits := p.Bits()
	for i := range a {
		for b := 0; b < 8; b++ {
			if i*8+b >= bits {
				a[i] |= 0x80 >> b
			}
		}
	}
	addr, _ := netip.AddrFromSlice(a)
	return addr
}
