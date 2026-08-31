// TURN-over-TLS allocation probe: mints LiveKit TURN creds with livekit's own
// scheme (jxskiss/base62 + sha256, verbatim from pkg/service/turn.go@v1.12.0)
// and performs a real TURN allocation through turns:dev.turn.matrix.inblock.io:443
// using pion/turn with system CA validation (crypto/tls default roots).
package main

import (
	"crypto/sha256"
	"crypto/tls"
	"fmt"
	"os"
	"time"

	"github.com/jxskiss/base62"
	"github.com/pion/turn/v4"
)

func main() {
	host := os.Getenv("TURN_PROBE_HOST")
	if host == "" {
		host = "dev.turn.matrix.inblock.io"
	}
	var user, pass string
	if os.Args[1] == "probe" {
		user, pass = os.Args[2], os.Args[3]
	} else {
		apiKey, secret := os.Args[1], os.Args[2]
		pID := "turnprobe-e2e"
		expiry := time.Now().Add(600 * time.Second).Unix()
		user = base62.EncodeToString([]byte(fmt.Sprintf("%s|%s|%d", apiKey, pID, expiry)))
		sum := sha256.Sum256([]byte(fmt.Sprintf("%s|%s|%d", secret, pID, expiry)))
		pass = base62.EncodeToString(sum[:])
		if len(os.Args) > 3 && os.Args[3] == "mint" {
			fmt.Println(user)
			fmt.Println(pass)
			return
		}
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
