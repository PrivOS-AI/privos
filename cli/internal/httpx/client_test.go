package httpx

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRefusesNonGET(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	defer srv.Close()
	c := New(srv.URL, nil, time.Second, "privos-cli/test")
	_, err := c.Do(context.Background(), http.MethodPost, "/api/projects", nil)
	if err == nil || !strings.Contains(err.Error(), "refusing POST") {
		t.Fatalf("err %v", err)
	}
	if called {
		t.Fatal("server was called")
	}
}

func TestDoesNotFollowRedirect(t *testing.T) {
	var hits []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, r.URL.Path)
		if r.URL.Path == "/api/projects" {
			http.Redirect(w, r, "/elsewhere", http.StatusFound)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	h := make(http.Header)
	h.Set("x-api-key", "secret-key")
	c := New(srv.URL, h, time.Second, "privos-cli/test")
	_, err := c.Get(context.Background(), "/api/projects", nil)
	if err == nil || !strings.Contains(err.Error(), "HTTP 302") {
		t.Fatalf("err %v", err)
	}
	if strings.Contains(err.Error(), "secret-key") {
		t.Fatalf("key in error %v", err)
	}
	if len(hits) != 1 || hits[0] != "/api/projects" {
		t.Fatalf("hits %v", hits)
	}
}

func TestAPIMessage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"Unauthorized","message":"Valid API key required"}`))
	}))
	defer srv.Close()
	c := New(srv.URL, nil, time.Second, "privos-cli/test")
	_, err := c.Get(context.Background(), "/api/tasks", nil)
	if err == nil || !strings.Contains(err.Error(), "Valid API key required") {
		t.Fatalf("err %v", err)
	}
}
