package cli

import (
	"strconv"
	"strings"
	"time"
)

// parsed is the argv split into flags and the command path.
type parsed struct {
	help         bool
	version      bool
	raw          bool
	format       string
	timeout      string
	url          string
	apiKey       string
	userID       string
	authToken    string
	projects     []string
	status       string
	limit        string
	after        string
	room         string
	kind         string
	count        string
	offset       string
	id           string
	list         string
	updatedSince string
	positionals  []string
	seen         map[string]bool
}

func (p parsed) command() string {
	return strings.Join(p.positionals, " ")
}

func (p parsed) forbidUnknown(cmd string, allowed ...string) error {
	ok := map[string]bool{
		"format":  true,
		"raw":     true,
		"timeout": true,
		"help":    true,
	}
	for _, name := range allowed {
		ok[name] = true
	}
	var bad []string
	for name := range p.seen {
		if !ok[name] {
			bad = append(bad, "--"+name)
		}
	}
	if len(bad) == 0 {
		return nil
	}
	sortStrings(bad)
	return usagef("%s: unsupported flag %s", cmd, strings.Join(bad, ", "))
}

func sortStrings(v []string) {
	for i := 1; i < len(v); i++ {
		for j := i; j > 0 && v[j] < v[j-1]; j-- {
			v[j], v[j-1] = v[j-1], v[j]
		}
	}
}

func (p parsed) timeoutDuration() (time.Duration, error) {
	if strings.TrimSpace(p.timeout) == "" {
		return 30 * time.Second, nil
	}
	n, err := strconv.Atoi(strings.TrimSpace(p.timeout))
	if err != nil || n < 1 || n > 300 {
		return 0, usagef("--timeout must be a whole number of seconds from 1 to 300")
	}
	return time.Duration(n) * time.Second, nil
}

func optionalNonNegative(flagName, value string) (bool, int, error) {
	if strings.TrimSpace(value) == "" {
		return false, 0, nil
	}
	n, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || n < 0 {
		return false, 0, usagef("%s must be a non-negative integer", flagName)
	}
	return true, n, nil
}

func normalizeKind(kind string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "", "channel", "c":
		return "channel", nil
	case "group", "private", "p":
		return "group", nil
	case "direct", "im", "dm", "d":
		return "direct", nil
	default:
		return "", usagef("--kind must be channel, group, or direct (aliases c, p, d)")
	}
}

func messagePath(kind string) string {
	switch kind {
	case "group":
		return "/api/v1/groups.messages"
	case "direct":
		return "/api/v1/im.messages"
	default:
		return "/api/v1/channels.messages"
	}
}

var valueFlags = map[string]bool{
	"format":        true,
	"timeout":       true,
	"url":           true,
	"api-key":       true,
	"user-id":       true,
	"auth-token":    true,
	"project":       true,
	"status":        true,
	"limit":         true,
	"after":         true,
	"room":          true,
	"kind":          true,
	"count":         true,
	"offset":        true,
	"id":            true,
	"list":          true,
	"updated-since": true,
}

// looksLikeFlag reports a flag token. A leading minus followed by a digit
// is a negative number ("-1"), not a flag.
func looksLikeFlag(s string) bool {
	if s == "-" || !strings.HasPrefix(s, "-") {
		return false
	}
	if len(s) > 1 && s[1] >= '0' && s[1] <= '9' {
		return false
	}
	return true
}

func parseArgs(args []string) (parsed, error) {
	var p parsed
	p.seen = map[string]bool{}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			p.positionals = append(p.positionals, args[i+1:]...)
			break
		}
		if a == "-" || !strings.HasPrefix(a, "-") {
			p.positionals = append(p.positionals, a)
			continue
		}
		name := a
		value := ""
		hasValue := false
		if strings.HasPrefix(a, "--") {
			name = strings.TrimPrefix(a, "--")
			if eq := strings.IndexByte(name, '='); eq >= 0 {
				value = name[eq+1:]
				name = name[:eq]
				hasValue = true
			}
		} else {
			// Only -h is accepted. Clustered short flags are not.
			if a == "-h" {
				name = "help"
			} else {
				return parsed{}, usagef("unknown flag %s", a)
			}
		}
		if name == "" {
			return parsed{}, usagef("missing flag name")
		}
		if name == "help" || name == "version" || name == "raw" {
			if hasValue {
				return parsed{}, usagef("--%s does not take a value", name)
			}
			if p.seen[name] {
				return parsed{}, usagef("--%s repeated", name)
			}
			p.seen[name] = true
			switch name {
			case "help":
				p.help = true
			case "version":
				p.version = true
			case "raw":
				p.raw = true
			}
			continue
		}
		if !valueFlags[name] {
			return parsed{}, usagef("unknown flag --%s", name)
		}
		if !hasValue {
			if i+1 >= len(args) || looksLikeFlag(args[i+1]) {
				return parsed{}, usagef("--%s requires a value", name)
			}
			i++
			value = args[i]
		}
		if err := assignFlag(&p, name, value); err != nil {
			return parsed{}, err
		}
	}
	if p.format != "" && p.format != "json" && p.format != "table" {
		return parsed{}, usagef("--format must be json or table")
	}
	return p, nil
}

func assignFlag(p *parsed, name, value string) error {
	if name != "project" && p.seen[name] {
		return usagef("--%s repeated", name)
	}
	p.seen[name] = true
	value = strings.TrimSpace(value)
	if value == "" {
		return usagef("--%s requires a value", name)
	}
	switch name {
	case "format":
		p.format = value
	case "timeout":
		p.timeout = value
	case "url":
		p.url = value
	case "api-key":
		p.apiKey = value
	case "user-id":
		p.userID = value
	case "auth-token":
		p.authToken = value
	case "project":
		p.projects = append(p.projects, value)
	case "status":
		p.status = value
	case "limit":
		p.limit = value
	case "after":
		p.after = value
	case "room":
		p.room = value
	case "kind":
		p.kind = value
	case "count":
		p.count = value
	case "offset":
		p.offset = value
	case "id":
		p.id = value
	case "list":
		p.list = value
	case "updated-since":
		p.updatedSince = value
	default:
		return usagef("unknown flag --%s", name)
	}
	return nil
}

func (p parsed) require(flagName, value string) error {
	if strings.TrimSpace(value) == "" {
		return usagef("%s: required flag --%s\n\n%s", p.command(), flagName, helpFor(p.positionals))
	}
	return nil
}

func fmtIntQuery(set bool, n int) string {
	if !set {
		return ""
	}
	return strconv.Itoa(n)
}
