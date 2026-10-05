// Command privos is the PrivOS operator CLI (sandbox board and hub).
//
//	go build -o privos ./cmd/privos
//	./privos --help
package main

import (
	"os"

	"github.com/PrivOS-AI/privos/cli/internal/cli"
)

func main() {
	os.Exit(cli.Run(os.Args[1:], os.Stdout, os.Stderr))
}
