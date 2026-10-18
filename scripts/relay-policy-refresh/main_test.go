package main

import (
	"net/netip"
	"testing"
)

func prefixes(ss ...string) []netip.Prefix {
	var out []netip.Prefix
	for _, s := range ss {
		out = append(out, netip.MustParsePrefix(s))
	}
	return out
}

func TestCollapse(t *testing.T) {
	for _, tc := range []struct {
		in, want []netip.Prefix
	}{
		// siblings merge, repeatedly
		{prefixes("10.0.0.0/25", "10.0.0.128/25", "10.0.1.0/24"), prefixes("10.0.0.0/23")},
		// covered prefixes go, unaligned neighbours stay
		{prefixes("10.0.1.0/24", "10.0.2.0/24", "10.0.2.0/25"), prefixes("10.0.1.0/24", "10.0.2.0/24")},
		// duplicates and unmasked input
		{prefixes("192.0.2.7/24", "192.0.2.0/24"), prefixes("192.0.2.0/24")},
		// IPv4 before IPv6, IPv6 merges
		{prefixes("2001:db8:1::/49", "2001:db8:1:8000::/49", "198.51.100.0/24"), prefixes("198.51.100.0/24", "2001:db8:1::/48")},
	} {
		got := collapse(tc.in)
		if len(got) != len(tc.want) {
			t.Fatalf("collapse(%v) = %v, want %v", tc.in, got, tc.want)
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Fatalf("collapse(%v) = %v, want %v", tc.in, got, tc.want)
			}
		}
	}
}

func TestLastAddr(t *testing.T) {
	for p, want := range map[string]string{
		"10.0.0.0/23":    "10.0.1.255",
		"10.0.0.0/32":    "10.0.0.0",
		"2001:db8::/120": "2001:db8::ff",
	} {
		if got := lastAddr(netip.MustParsePrefix(p)); got.String() != want {
			t.Fatalf("lastAddr(%s) = %s, want %s", p, got, want)
		}
	}
}
