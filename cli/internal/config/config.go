// Package config resolves privos CLI endpoints and credentials from flags
// and environment variables. Flags win. Empty values are treated as unset.
package config

import (
	"fmt"
	"net/url"
	"os"
	"strings"
)

// Version is the CLI version printed by `privos version`.
const Version = "0.1.0"

// Sandbox is the board API target. APIKey is sent as the x-api-key header.
type Sandbox struct {
	BaseURL string
	APIKey  string
}

// Hub is the PrivOS Hub (Rocket.Chat-derived) target.
// UserID and AuthToken are sent as X-User-Id and X-Auth-Token.
type Hub struct {
	BaseURL   string
	UserID    string
	AuthToken string
}

func getenv(key string) string {
	return strings.TrimSpace(os.Getenv(key))
}

func first(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// NormalizeBaseURL checks that raw is an absolute http(s) URL with no
// userinfo, and returns it without a trailing slash, query, or fragment.
func NormalizeBaseURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("base URL is empty")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("base URL %q must be an absolute http or https URL", raw)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("base URL %q must use http or https", raw)
	}
	if u.User != nil {
		return "", fmt.Errorf("base URL must not include userinfo; pass credentials with flags or environment variables")
	}
	u.RawQuery = ""
	u.Fragment = ""
	return strings.TrimRight(u.String(), "/"), nil
}

func rejectNewlines(label, value string) error {
	if strings.ContainsAny(value, "\r\n") {
		return fmt.Errorf("%s contains a newline", label)
	}
	return nil
}

// ResolveSandbox loads the board base URL and API key.
//
// URL: --url, then PRIVOS_SANDBOX_URL.
// Key: --api-key, then PRIVOS_SANDBOX_API_KEY, API_ACCESS_KEY, SANDBOX_API_KEY.
func ResolveSandbox(flagURL, flagKey string) (Sandbox, error) {
	rawURL := first(flagURL, getenv("PRIVOS_SANDBOX_URL"))
	if rawURL == "" {
		return Sandbox{}, fmt.Errorf("sandbox base URL is required.\nSet --url or PRIVOS_SANDBOX_URL.\nA default self-hosted board listens on http://127.0.0.1:8556")
	}
	base, err := NormalizeBaseURL(rawURL)
	if err != nil {
		return Sandbox{}, fmt.Errorf("sandbox %w", err)
	}
	key := first(flagKey, getenv("PRIVOS_SANDBOX_API_KEY"), getenv("API_ACCESS_KEY"), getenv("SANDBOX_API_KEY"))
	if key == "" {
		return Sandbox{}, fmt.Errorf("sandbox API key is required.\nSet --api-key or one of PRIVOS_SANDBOX_API_KEY, API_ACCESS_KEY, SANDBOX_API_KEY.\nThe board reads this value from the x-api-key header (container env API_ACCESS_KEY).")
	}
	if err := rejectNewlines("sandbox API key", key); err != nil {
		return Sandbox{}, err
	}
	return Sandbox{BaseURL: base, APIKey: key}, nil
}

// ResolveHub loads the hub base URL and user-token credentials.
//
// URL: --url, then PRIVOS_HUB_URL, then PRIVOS_ROOT_URL.
// User: --user-id, then PRIVOS_HUB_USER_ID.
// Token: --auth-token, then PRIVOS_HUB_AUTH_TOKEN.
func ResolveHub(flagURL, flagUser, flagToken string) (Hub, error) {
	rawURL := first(flagURL, getenv("PRIVOS_HUB_URL"), getenv("PRIVOS_ROOT_URL"))
	if rawURL == "" {
		return Hub{}, fmt.Errorf("hub base URL is required.\nSet --url, PRIVOS_HUB_URL, or PRIVOS_ROOT_URL.\nA default self-hosted hub listens on http://127.0.0.1:3000")
	}
	base, err := NormalizeBaseURL(rawURL)
	if err != nil {
		return Hub{}, fmt.Errorf("hub %w", err)
	}
	user := first(flagUser, getenv("PRIVOS_HUB_USER_ID"))
	if user == "" {
		return Hub{}, fmt.Errorf("hub user id is required.\nSet --user-id or PRIVOS_HUB_USER_ID.\nSend it as the X-User-Id header.")
	}
	token := first(flagToken, getenv("PRIVOS_HUB_AUTH_TOKEN"))
	if token == "" {
		return Hub{}, fmt.Errorf("hub auth token is required.\nSet --auth-token or PRIVOS_HUB_AUTH_TOKEN.\nSend it as the X-Auth-Token header.")
	}
	if err := rejectNewlines("hub user id", user); err != nil {
		return Hub{}, err
	}
	if err := rejectNewlines("hub auth token", token); err != nil {
		return Hub{}, err
	}
	return Hub{BaseURL: base, UserID: user, AuthToken: token}, nil
}
