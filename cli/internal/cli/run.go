package cli

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/PrivOS-AI/privos/cli/internal/config"
	"github.com/PrivOS-AI/privos/cli/internal/httpx"
	"github.com/PrivOS-AI/privos/cli/internal/render"
)

// UsageError is a bad invocation. Run exits 2.
type UsageError struct{ Msg string }

func (e *UsageError) Error() string { return e.Msg }

func usagef(format string, args ...any) error {
	return &UsageError{Msg: fmt.Sprintf(format, args...)}
}

// Run executes the CLI and returns the process exit code.
func Run(args []string, stdout, stderr io.Writer) int {
	p, err := parseArgs(args)
	if err != nil {
		fmt.Fprintln(stderr, err.Error())
		return 2
	}
	if err := dispatch(p, stdout); err != nil {
		fmt.Fprintln(stderr, err.Error())
		var usage *UsageError
		if ok := asUsage(err, &usage); ok {
			return 2
		}
		return 1
	}
	return 0
}

func asUsage(err error, target **UsageError) bool {
	u, ok := err.(*UsageError)
	if !ok {
		return false
	}
	*target = u
	return true
}

func dispatch(p parsed, stdout io.Writer) error {
	if len(p.positionals) == 0 {
		if p.help {
			fmt.Fprint(stdout, rootHelp)
			return nil
		}
		if p.seen["version"] {
			if err := p.forbidUnknown("privos version"); err != nil {
				return err
			}
			fmt.Fprintf(stdout, "privos %s\n", config.Version)
			return nil
		}
		return usagef("missing command\n\nRun privos --help")
	}
	if p.positionals[0] == "help" {
		if len(p.positionals) != 1 {
			return usagef("privos help: unexpected arguments")
		}
		fmt.Fprint(stdout, rootHelp)
		return nil
	}
	text := helpFor(p.positionals)
	if text == "" {
		return usagef("unknown command %q\n\nRun privos --help", p.command())
	}
	if p.help {
		fmt.Fprint(stdout, text)
		return nil
	}
	if p.seen["version"] {
		return usagef("pass --version or \"privos version\" on its own")
	}

	switch p.command() {
	case "version":
		if err := p.forbidUnknown("privos version"); err != nil {
			return err
		}
		fmt.Fprintf(stdout, "privos %s\n", config.Version)
		return nil
	case "sandbox", "sandbox projects", "sandbox tasks":
		return usagef("%s\nRun privos %s --help", strings.TrimRight(text, "\n"), p.command())
	case "sandbox projects list":
		return cmdSandboxProjects(p, stdout)
	case "sandbox tasks list":
		return cmdSandboxTasks(p, stdout)
	case "hub", "hub rooms", "hub messages", "hub lists", "hub items":
		return usagef("%s\nRun privos %s --help", strings.TrimRight(text, "\n"), p.command())
	case "hub rooms list":
		return cmdHubRooms(p, stdout)
	case "hub messages list":
		return cmdHubMessages(p, stdout)
	case "hub lists list":
		return cmdNotWired(p, "hub lists list", []string{"url", "user-id", "auth-token", "room"}, roomFilter(p.room))
	case "hub lists get":
		if err := p.forbidUnknown("hub lists get", "url", "user-id", "auth-token", "id"); err != nil {
			return err
		}
		if _, err := p.timeoutDuration(); err != nil {
			return err
		}
		if err := p.require("id", p.id); err != nil {
			return err
		}
		return notWired("hub lists get", "id="+p.id)
	case "hub items list":
		if err := p.forbidUnknown("hub items list", "url", "user-id", "auth-token", "list"); err != nil {
			return err
		}
		if _, err := p.timeoutDuration(); err != nil {
			return err
		}
		if err := p.require("list", p.list); err != nil {
			return err
		}
		return notWired("hub items list", "list="+p.list)
	case "hub items get":
		if err := p.forbidUnknown("hub items get", "url", "user-id", "auth-token", "id"); err != nil {
			return err
		}
		if _, err := p.timeoutDuration(); err != nil {
			return err
		}
		if err := p.require("id", p.id); err != nil {
			return err
		}
		return notWired("hub items get", "id="+p.id)
	default:
		return usagef("unknown command %q\n\nRun privos --help", p.command())
	}
}

func roomFilter(room string) string {
	if room == "" {
		return "room=(all)"
	}
	return "room=" + room
}

func cmdNotWired(p parsed, cmd string, allowed []string, filter string) error {
	if err := p.forbidUnknown(cmd, allowed...); err != nil {
		return err
	}
	if _, err := p.timeoutDuration(); err != nil {
		return err
	}
	return notWired(cmd, filter)
}

func notWired(cmd, filter string) error {
	return usagef("%s is not wired to a live request in this version.\nNo HTTP request was sent.\n\nAccepted filters: %s\nSee docs/api/hub.md.", cmd, filter)
}

func userAgent() string {
	return "privos-cli/" + config.Version
}

func (p parsed) deadline() (context.Context, context.CancelFunc, error) {
	d, err := p.timeoutDuration()
	if err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), d)
	return ctx, cancel, nil
}

func cmdSandboxProjects(p parsed, stdout io.Writer) error {
	if err := p.forbidUnknown("sandbox projects list", "url", "api-key"); err != nil {
		return err
	}
	return sandboxGet(p, stdout, "/api/projects", nil, "", projectColumns())
}

func cmdSandboxTasks(p parsed, stdout io.Writer) error {
	if err := p.forbidUnknown("sandbox tasks list", "url", "api-key", "project", "status", "limit", "after"); err != nil {
		return err
	}
	setLimit, limit, err := optionalNonNegative("--limit", p.limit)
	if err != nil {
		return err
	}
	q := url.Values{}
	if len(p.projects) > 0 {
		q.Set("projectIds", strings.Join(p.projects, ","))
	}
	if p.status != "" {
		q.Set("status", p.status)
	}
	if setLimit {
		q.Set("limit", fmtIntQuery(true, limit))
	}
	if p.after != "" {
		q.Set("after", p.after)
	}
	return sandboxGet(p, stdout, "/api/tasks", q, "", taskColumns())
}

func projectColumns() []render.Column {
	return []render.Column{
		{Header: "ID", Path: []string{"id"}},
		{Header: "NAME", Path: []string{"name"}},
	}
}

func taskColumns() []render.Column {
	return []render.Column{
		{Header: "ID", Path: []string{"id"}},
		{Header: "TITLE", Path: []string{"title"}},
		{Header: "STATUS", Path: []string{"status"}},
		{Header: "PROJECT", Path: []string{"projectId"}},
	}
}

func sandboxGet(p parsed, stdout io.Writer, path string, query url.Values, unwrap string, cols []render.Column) error {
	cfg, err := config.ResolveSandbox(p.url, p.apiKey)
	if err != nil {
		return usagef("%s", err.Error())
	}
	ctx, cancel, err := p.deadline()
	if err != nil {
		return err
	}
	defer cancel()
	headers := make(http.Header)
	headers.Set("x-api-key", cfg.APIKey)
	client := httpx.New(cfg.BaseURL, headers, timeoutOrDefault(p), userAgent())
	body, err := client.Get(ctx, path, query)
	if err != nil {
		return err
	}
	return render.Write(stdout, body, p.format, p.raw, unwrap, cols)
}

func cmdHubRooms(p parsed, stdout io.Writer) error {
	if err := p.forbidUnknown("hub rooms list", "url", "user-id", "auth-token", "updated-since"); err != nil {
		return err
	}
	q := url.Values{}
	if p.updatedSince != "" {
		q.Set("updatedSince", p.updatedSince)
	}
	return hubGet(p, stdout, "/api/v1/rooms.get", q, "update", []render.Column{
		{Header: "ID", Path: []string{"_id"}},
		{Header: "T", Path: []string{"t"}},
		{Header: "NAME", Path: []string{"name"}},
		{Header: "FNAME", Path: []string{"fname"}},
	})
}

func cmdHubMessages(p parsed, stdout io.Writer) error {
	if err := p.forbidUnknown("hub messages list", "url", "user-id", "auth-token", "room", "kind", "count", "offset"); err != nil {
		return err
	}
	if err := p.require("room", p.room); err != nil {
		return err
	}
	kind, err := normalizeKind(p.kind)
	if err != nil {
		return err
	}
	setCount, count, err := optionalNonNegative("--count", p.count)
	if err != nil {
		return err
	}
	setOffset, offset, err := optionalNonNegative("--offset", p.offset)
	if err != nil {
		return err
	}
	q := url.Values{}
	q.Set("roomId", p.room)
	if setCount {
		q.Set("count", fmtIntQuery(true, count))
	}
	if setOffset {
		q.Set("offset", fmtIntQuery(true, offset))
	}
	return hubGet(p, stdout, messagePath(kind), q, "messages", []render.Column{
		{Header: "ID", Path: []string{"_id"}},
		{Header: "TS", Path: []string{"ts"}},
		{Header: "USER", Path: []string{"u", "username"}},
		{Header: "MSG", Path: []string{"msg"}},
	})
}

func hubGet(p parsed, stdout io.Writer, path string, query url.Values, unwrap string, cols []render.Column) error {
	cfg, err := config.ResolveHub(p.url, p.userID, p.authToken)
	if err != nil {
		return usagef("%s", err.Error())
	}
	ctx, cancel, err := p.deadline()
	if err != nil {
		return err
	}
	defer cancel()
	headers := make(http.Header)
	headers.Set("X-User-Id", cfg.UserID)
	headers.Set("X-Auth-Token", cfg.AuthToken)
	client := httpx.New(cfg.BaseURL, headers, timeoutOrDefault(p), userAgent())
	body, err := client.Get(ctx, path, query)
	if err != nil {
		return err
	}
	return render.Write(stdout, body, p.format, p.raw, unwrap, cols)
}

func timeoutOrDefault(p parsed) time.Duration {
	d, err := p.timeoutDuration()
	if err != nil {
		return 30 * time.Second
	}
	return d
}
