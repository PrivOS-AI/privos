package config

import "testing"

func TestSandboxKeyPrecedence(t *testing.T) {
	t.Setenv("PRIVOS_SANDBOX_URL", "http://127.0.0.1:8556/")
	t.Setenv("SANDBOX_API_KEY", "installer")
	t.Setenv("API_ACCESS_KEY", "board")
	t.Setenv("PRIVOS_SANDBOX_API_KEY", "privos")

	cfg, err := ResolveSandbox("", "")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.BaseURL != "http://127.0.0.1:8556" {
		t.Fatalf("url %q", cfg.BaseURL)
	}
	if cfg.APIKey != "privos" {
		t.Fatalf("key %q", cfg.APIKey)
	}

	cfg, err = ResolveSandbox("https://board.example", "flag-key")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.BaseURL != "https://board.example" || cfg.APIKey != "flag-key" {
		t.Fatalf("%+v", cfg)
	}
}

func TestSandboxFallsBackToInstallerKey(t *testing.T) {
	t.Setenv("PRIVOS_SANDBOX_URL", "http://127.0.0.1:8556")
	t.Setenv("PRIVOS_SANDBOX_API_KEY", "")
	t.Setenv("API_ACCESS_KEY", "")
	t.Setenv("SANDBOX_API_KEY", "installer")
	cfg, err := ResolveSandbox("", "")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.APIKey != "installer" {
		t.Fatalf("key %q", cfg.APIKey)
	}
}

func TestHubURLFallback(t *testing.T) {
	t.Setenv("PRIVOS_HUB_URL", "")
	t.Setenv("PRIVOS_ROOT_URL", "http://127.0.0.1:3000/")
	t.Setenv("PRIVOS_HUB_USER_ID", "uid")
	t.Setenv("PRIVOS_HUB_AUTH_TOKEN", "tok")
	cfg, err := ResolveHub("", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.BaseURL != "http://127.0.0.1:3000" || cfg.UserID != "uid" || cfg.AuthToken != "tok" {
		t.Fatalf("%+v", cfg)
	}
}

func TestNormalizeBaseURL(t *testing.T) {
	cases := []string{
		"127.0.0.1:8556",
		"ftp://example.com",
		"http://user:secret@example.com",
		"",
	}
	for _, raw := range cases {
		if _, err := NormalizeBaseURL(raw); err == nil {
			t.Fatalf("accepted %q", raw)
		}
	}
}
