// TURN-over-TLS allocation probe for LiveKit's embedded TURN server: mints
// LiveKit TURN credentials and performs a real TURN allocation through
// turns:<host>:443, using pion/turn with system CA validation (crypto/tls
// default roots).
//
// The credential derivation REIMPLEMENTS LiveKit's TURNAuthHandler
// (pkg/service/turn.go at v1.12.0); it is not a copy of that code. Username:
// base62("<api key>|<participant id>|<unix expiry>"); password:
// base62(sha256("<api secret>|<participant id>|<unix expiry>")); realm
// "livekit". Re-check it against that file whenever LiveKit is bumped.
//
// There is no default host on purpose: a probe that silently targets somebody
// else's TURN server proves nothing about yours. Pass the deployment's TURN
// domain (`turn.domain` in config/livekit.yaml) with -host or TURN_PROBE_HOST.
package main

import (
	"crypto/sha256"
	"crypto/tls"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/jxskiss/base62"
	"github.com/pion/turn/v4"
)

func usage() {
	fmt.Fprint(os.Stderr, `usage:
  turnprobe -host <turn-domain> <api-key> <api-secret>        mint credentials, then allocate
  turnprobe <api-key> <api-secret> mint                       print the minted username and password
  turnprobe -host <turn-domain> probe <username> <password>   allocate with the given credentials

-host defaults to $TURN_PROBE_HOST and is required whenever the probe dials.
`)
	os.Exit(2)
}

func main() {
	hostFlag := flag.String("host", os.Getenv("TURN_PROBE_HOST"),
		"TURN domain to probe on :443 (turn.domain in config/livekit.yaml)")
	flag.Usage = usage
	flag.Parse()
	args := flag.Args()

	var user, pass string
	switch {
	case len(args) == 3 && args[0] == "probe":
		user, pass = args[1], args[2]
	case len(args) == 2 || (len(args) == 3 && args[2] == "mint"):
		apiKey, secret := args[0], args[1]
		pID := "turnprobe-e2e"
		expiry := time.Now().Add(600 * time.Second).Unix()
		user = base62.EncodeToString([]byte(fmt.Sprintf("%s|%s|%d", apiKey, pID, expiry)))
		sum := sha256.Sum256([]byte(fmt.Sprintf("%s|%s|%d", secret, pID, expiry)))
		pass = base62.EncodeToString(sum[:])
		if len(args) == 3 {
			fmt.Println(user)
			fmt.Println(pass)
			return
		}
	default:
		usage()
	}

	host := *hostFlag
	if host == "" {
		fmt.Fprintln(os.Stderr, "turnprobe: -host (or TURN_PROBE_HOST) is required")
		usage()
	}

	conn, err := tls.Dial("tcp", host+":443", &tls.Config{ServerName: host})
	if err != nil {
		fmt.Println("FAIL tls.Dial:", err)
		os.Exit(1)
	}
	fmt.Printf("TLS OK: cipher=%x verified-chains-present=%v peer-cn=%s\n",
		conn.ConnectionState().CipherSuite,
		len(conn.ConnectionState().VerifiedChains) > 0,
		conn.ConnectionState().PeerCertificates[0].Subject.CommonName)

	client, err := turn.NewClient(&turn.ClientConfig{
		STUNServerAddr: host + ":443",
		TURNServerAddr: host + ":443",
		Conn:           turn.NewSTUNConn(conn),
		Username:       user,
		Password:       pass,
		Realm:          "livekit",
	})
	if err != nil {
		fmt.Println("FAIL NewClient:", err)
		os.Exit(1)
	}
	defer client.Close()
	if err := client.Listen(); err != nil {
		fmt.Println("FAIL Listen:", err)
		os.Exit(1)
	}
	relay, err := client.Allocate()
	if err != nil {
		fmt.Println("FAIL Allocate:", err)
		os.Exit(1)
	}
	defer relay.Close()
	fmt.Println("ALLOCATION OK: relayed address =", relay.LocalAddr())
}
