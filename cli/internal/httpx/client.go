// Package httpx is the read-only HTTP client used by privos.
// Non-GET requests are refused unless AllowMutation is set. No command in
// this version sets it. Redirects are not followed, so a credential header
// cannot be replayed onto another host.
package httpx

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxBody = 8 << 20

// Client talks to one base URL with a fixed header set.
type Client struct {
	BaseURL       string
	Headers       http.Header
	HTTP          *http.Client
	AllowMutation bool
}

// Error is a non-2xx response. The message prefers a JSON message or error
// field and never includes request headers.
type Error struct {
	Method string
	Path   string
	Status int
	Body   string
}

func (e *Error) Error() string {
	msg := apiMessage(e.Body)
	if msg == "" {
		msg = oneLine(e.Body)
	}
	if msg == "" {
		return fmt.Sprintf("%s %s: HTTP %d", e.Method, e.Path, e.Status)
	}
	return fmt.Sprintf("%s %s: HTTP %d: %s", e.Method, e.Path, e.Status, msg)
}

func apiMessage(body string) string {
	var payload map[string]any
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		return ""
	}
	for _, key := range []string{"message", "error"} {
		if s, ok := payload[key].(string); ok {
			s = oneLine(s)
			if s != "" {
				return s
			}
		}
	}
	return ""
}

func oneLine(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) > 300 {
		s = s[:300] + "..."
	}
	return s
}

// New builds a client that does not follow redirects.
func New(baseURL string, headers http.Header, timeout time.Duration, userAgent string) *Client {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	h := headers.Clone()
	if h == nil {
		h = make(http.Header)
	}
	if h.Get("Accept") == "" {
		h.Set("Accept", "application/json")
	}
	if userAgent != "" && h.Get("User-Agent") == "" {
		h.Set("User-Agent", userAgent)
	}
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Headers: h,
		HTTP: &http.Client{
			Timeout: timeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

// Get sends a GET request. query may be nil.
func (c *Client) Get(ctx context.Context, path string, query url.Values) ([]byte, error) {
	return c.Do(ctx, http.MethodGet, path, query)
}

// Do sends method. Anything other than GET fails unless AllowMutation is set.
func (c *Client) Do(ctx context.Context, method, path string, query url.Values) ([]byte, error) {
	if method != http.MethodGet && !c.AllowMutation {
		return nil, fmt.Errorf("refusing %s %s: privos only sends GET unless a command explicitly allows a mutation", method, path)
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	u, err := url.Parse(c.BaseURL + path)
	if err != nil {
		return nil, fmt.Errorf("build url: %w", err)
	}
	if len(query) > 0 {
		u.RawQuery = query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), nil)
	if err != nil {
		return nil, err
	}
	for key, values := range c.Headers {
		for _, value := range values {
			req.Header.Add(key, value)
		}
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		return nil, fmt.Errorf("%s %s: read body: %w", method, path, err)
	}
	if len(body) > maxBody {
		return nil, fmt.Errorf("%s %s: response exceeds %d bytes", method, path, maxBody)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &Error{Method: method, Path: path, Status: resp.StatusCode, Body: string(body)}
	}
	return body, nil
}
