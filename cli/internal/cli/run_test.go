package cli

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func clearCreds(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"PRIVOS_SANDBOX_URL",
		"PRIVOS_SANDBOX_API_KEY",
		"API_ACCESS_KEY",
		"SANDBOX_API_KEY",
		"PRIVOS_HUB_URL",
		"PRIVOS_ROOT_URL",
		"PRIVOS_HUB_USER_ID",
		"PRIVOS_HUB_AUTH_TOKEN",
	} {
		t.Setenv(key, "")
	}
}

func runCLI(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := Run(args, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestRootHelp(t *testing.T) {
	clearCreds(t)
	code, stdout, stderr := runCLI(t, "--help")
	if code != 0 {
		t.Fatalf("exit %d stderr %s", code, stderr)
	}
	if stderr != "" {
		t.Fatalf("stderr %q", stderr)
	}
	for _, want := range []string{"sandbox", "hub", "read-only", "docs/cli/README.md"} {
		if !strings.Contains(stdout, want) {
			t.Fatalf("help missing %q\n%s", want, stdout)
		}
	}
}

func TestMissingCommand(t *testing.T) {
	clearCreds(t)
	code, _, stderr := runCLI(t)
	if code != 2 || !strings.Contains(stderr, "missing command") {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
}

func TestVersion(t *testing.T) {
	clearCreds(t)
	code, stdout, stderr := runCLI(t, "version")
	if code != 0 || stderr != "" || !strings.HasPrefix(stdout, "privos ") {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
}

func TestNegativeLimit(t *testing.T) {
	clearCreds(t)
	code, _, stderr := runCLI(t, "sandbox", "tasks", "list", "--url", "http://127.0.0.1:9", "--api-key", "k", "--limit", "-1")
	if code != 2 || !strings.Contains(stderr, "--limit") {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
}

func TestUnknownFlagAndCommand(t *testing.T) {
	clearCreds(t)
	code, _, stderr := runCLI(t, "sandbox", "projects", "list", "--nope")
	if code != 2 || !strings.Contains(stderr, "unknown flag") {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	code, _, stderr = runCLI(t, "sandbox", "nope")
	if code != 2 || !strings.Contains(stderr, "unknown command") {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
}

func TestSandboxProjectsListRequiresConfig(t *testing.T) {
	clearCreds(t)
	code, stdout, stderr := runCLI(t, "sandbox", "projects", "list")
	if code != 2 || stdout != "" {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
	if !strings.Contains(stderr, "PRIVOS_SANDBOX_URL") {
		t.Fatalf("stderr %q", stderr)
	}
}

func TestSandboxProjectsAndTasks(t *testing.T) {
	clearCreds(t)
	var gotKey string
	var taskQuery string
	var methods []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		methods = append(methods, r.Method+" "+r.URL.Path)
		gotKey = r.Header.Get("x-api-key")
		if r.Method != http.MethodGet {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/projects":
			_, _ = io.WriteString(w, `[{"id":"p1","name":"Alpha"}]`)
		case "/api/tasks":
			taskQuery = r.URL.RawQuery
			if r.URL.Query().Get("projectIds") != "p1,p2" || r.URL.Query().Get("status") != "todo" || r.URL.Query().Get("limit") != "10" {
				http.Error(w, "bad query", http.StatusBadRequest)
				return
			}
			_, _ = io.WriteString(w, `[{"id":"t1","title":"Write CLI","status":"todo","projectId":"p1"}]`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	code, stdout, stderr := runCLI(t, "--format", "table", "sandbox", "--url", srv.URL, "--api-key", "secret-key", "projects", "list")
	if code != 0 {
		t.Fatalf("projects exit %d stderr %s", code, stderr)
	}
	if gotKey != "secret-key" {
		t.Fatalf("x-api-key %q", gotKey)
	}
	if strings.Contains(stdout, "secret-key") || strings.Contains(stderr, "secret-key") {
		t.Fatalf("credential leaked stdout %q stderr %q", stdout, stderr)
	}
	if !strings.Contains(stdout, "Alpha") || !strings.Contains(stdout, "p1") {
		t.Fatalf("table %q", stdout)
	}

	code, stdout, stderr = runCLI(t, "sandbox", "tasks", "list", "--url="+srv.URL, "--api-key=secret-key", "--project", "p1", "--project", "p2", "--status", "todo", "--limit", "10")
	if code != 0 {
		t.Fatalf("tasks exit %d stderr %s query %s", code, stderr, taskQuery)
	}
	if !strings.Contains(stdout, "Write CLI") {
		t.Fatalf("stdout %q", stdout)
	}
	for _, m := range methods {
		if !strings.HasPrefix(m, "GET ") {
			t.Fatalf("non-get %s", m)
		}
	}
}

func TestSandboxAPIErrorDoesNotEchoKey(t *testing.T) {
	clearCreds(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":"Unauthorized","message":"Valid API key required"}`)
	}))
	defer srv.Close()
	code, stdout, stderr := runCLI(t, "sandbox", "projects", "list", "--url", srv.URL, "--api-key", "secret-key")
	if code != 1 || stdout != "" {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
	if !strings.Contains(stderr, "Valid API key required") || !strings.Contains(stderr, "GET /api/projects") {
		t.Fatalf("stderr %q", stderr)
	}
	if strings.Contains(stderr, "secret-key") {
		t.Fatalf("key leaked %q", stderr)
	}
}

func TestSandboxEnvPrecedence(t *testing.T) {
	clearCreds(t)
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("x-api-key")
		_, _ = io.WriteString(w, `[]`)
	}))
	defer srv.Close()
	t.Setenv("PRIVOS_SANDBOX_URL", srv.URL)
	t.Setenv("SANDBOX_API_KEY", "from-installer")
	t.Setenv("API_ACCESS_KEY", "from-board")
	t.Setenv("PRIVOS_SANDBOX_API_KEY", "from-privos")
	code, _, stderr := runCLI(t, "sandbox", "projects", "list")
	if code != 0 {
		t.Fatalf("exit %d stderr %s", code, stderr)
	}
	if got != "from-privos" {
		t.Fatalf("key %q", got)
	}
}

func TestHubRoomsAndMessages(t *testing.T) {
	clearCreds(t)
	var user, token, msgPath, room string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user = r.Header.Get("X-User-Id")
		token = r.Header.Get("X-Auth-Token")
		if r.Header.Get("x-api-key") != "" {
			t.Errorf("hub request carried x-api-key")
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/rooms.get":
			if r.URL.Query().Get("updatedSince") != "2026-01-01T00:00:00Z" {
				http.Error(w, "since", http.StatusBadRequest)
				return
			}
			_, _ = io.WriteString(w, `{"update":[{"_id":"room1","t":"c","name":"general","fname":"General"}],"remove":[],"success":true}`)
		case "/api/v1/groups.messages":
			msgPath = r.URL.Path
			room = r.URL.Query().Get("roomId")
			_, _ = io.WriteString(w, `{"messages":[{"_id":"m1","ts":"2026-01-02T00:00:00.000Z","msg":"hello","u":{"username":"ada"}}],"success":true}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	code, stdout, stderr := runCLI(t, "hub", "rooms", "list", "--url", srv.URL, "--user-id", "user-1", "--auth-token", "token-1", "--updated-since", "2026-01-01T00:00:00Z", "--format", "table")
	if code != 0 {
		t.Fatalf("rooms exit %d stderr %s", code, stderr)
	}
	if user != "user-1" || token != "token-1" {
		t.Fatalf("auth user %q token %q", user, token)
	}
	if strings.Contains(stdout, "token-1") || strings.Contains(stderr, "token-1") {
		t.Fatalf("token leaked")
	}
	if !strings.Contains(stdout, "general") || !strings.Contains(stdout, "room1") {
		t.Fatalf("table %q", stdout)
	}

	code, stdout, stderr = runCLI(t, "hub", "messages", "list", "--url", srv.URL, "--user-id", "user-1", "--auth-token", "token-1", "--room", "room1", "--kind", "p")
	if code != 0 {
		t.Fatalf("messages exit %d stderr %s", code, stderr)
	}
	if msgPath != "/api/v1/groups.messages" || room != "room1" {
		t.Fatalf("path %s room %s", msgPath, room)
	}
	if !strings.Contains(stdout, "hello") || !strings.Contains(stdout, "ada") {
		t.Fatalf("stdout %q", stdout)
	}
}

func TestHubMessagesRequiresRoom(t *testing.T) {
	clearCreds(t)
	code, _, stderr := runCLI(t, "hub", "messages", "list", "--url", "http://127.0.0.1:9", "--user-id", "u", "--auth-token", "t")
	if code != 2 || !strings.Contains(stderr, "--room") {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
}

func TestHubRootURLFallback(t *testing.T) {
	clearCreds(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"update":[],"remove":[],"success":true}`)
	}))
	defer srv.Close()
	t.Setenv("PRIVOS_ROOT_URL", srv.URL)
	t.Setenv("PRIVOS_HUB_USER_ID", "user-1")
	t.Setenv("PRIVOS_HUB_AUTH_TOKEN", "token-1")
	code, _, stderr := runCLI(t, "hub", "rooms", "list")
	if code != 0 {
		t.Fatalf("exit %d stderr %s", code, stderr)
	}
}

func TestHubListsAndItemsDoNotCallNetwork(t *testing.T) {
	clearCreds(t)
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		http.Error(w, "should not be called", http.StatusInternalServerError)
	}))
	defer srv.Close()

	code, stdout, stderr := runCLI(t, "hub", "lists", "--help")
	if code != 0 || !strings.Contains(stdout, "lists") || !strings.Contains(stdout, "Not wired") {
		t.Fatalf("help code %d stdout %q stderr %q", code, stdout, stderr)
	}

	code, stdout, stderr = runCLI(t, "hub", "lists", "list", "--room", "room1", "--url", srv.URL, "--user-id", "u", "--auth-token", "t")
	if code != 2 || stdout != "" || called {
		t.Fatalf("code %d called %v stdout %q stderr %q", code, called, stdout, stderr)
	}
	if !strings.Contains(stderr, "not wired") || !strings.Contains(stderr, "No HTTP request was sent") || !strings.Contains(stderr, "room=room1") {
		t.Fatalf("stderr %q", stderr)
	}

	code, _, stderr = runCLI(t, "hub", "items", "list")
	if code != 2 || !strings.Contains(stderr, "--list") || strings.Contains(stderr, "not wired") {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	code, _, stderr = runCLI(t, "hub", "items", "list", "--list", "list1", "--url", srv.URL)
	if code != 2 || !strings.Contains(stderr, "not wired") || !strings.Contains(stderr, "list=list1") || called {
		t.Fatalf("code %d called %v stderr %q", code, called, stderr)
	}
	code, _, stderr = runCLI(t, "hub", "lists", "list", "--project", "p1")
	if code != 2 || !strings.Contains(stderr, "unsupported flag") {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
}

func TestRejectsUserinfoURL(t *testing.T) {
	clearCreds(t)
	code, _, stderr := runCLI(t, "sandbox", "projects", "list", "--url", "http://user:pass@127.0.0.1:8556", "--api-key", "k")
	if code != 2 || !strings.Contains(stderr, "userinfo") {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
}
