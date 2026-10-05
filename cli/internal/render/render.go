// Package render prints API bodies as JSON or a plain-text table.
package render

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"
)

// Column is one table column. Path walks nested JSON objects.
type Column struct {
	Header string
	Path   []string
}

// Write prints body. raw writes the bytes unchanged. format is json or table.
// unwrap is the object key that holds the row array when the body is an
// object (for example rooms.get uses "update"). A top-level array is used as-is.
func Write(w io.Writer, body []byte, format string, raw bool, unwrap string, cols []Column) error {
	body = bytes.TrimSpace(body)
	if raw {
		if len(body) == 0 {
			_, err := io.WriteString(w, "\n")
			return err
		}
		if _, err := w.Write(body); err != nil {
			return err
		}
		_, err := io.WriteString(w, "\n")
		return err
	}
	switch format {
	case "", "json":
		return writeJSON(w, body)
	case "table":
		return writeTable(w, body, unwrap, cols)
	default:
		return fmt.Errorf("unsupported format %q (use json or table)", format)
	}
}

func writeJSON(w io.Writer, body []byte) error {
	if len(body) == 0 {
		_, err := io.WriteString(w, "\n")
		return err
	}
	var buf bytes.Buffer
	if err := json.Indent(&buf, body, "", "  "); err != nil {
		if _, werr := w.Write(body); werr != nil {
			return werr
		}
		_, err := io.WriteString(w, "\n")
		return err
	}
	buf.WriteByte('\n')
	_, err := w.Write(buf.Bytes())
	return err
}

func writeTable(w io.Writer, body []byte, unwrap string, cols []Column) error {
	if len(body) == 0 {
		return fmt.Errorf("empty response; use --format json or --raw")
	}
	var payload any
	if err := json.Unmarshal(body, &payload); err != nil {
		return fmt.Errorf("response is not JSON; use --format json or --raw")
	}
	rows, err := rowArray(payload, unwrap)
	if err != nil {
		return err
	}
	headers := make([]string, len(cols))
	for i, c := range cols {
		headers[i] = c.Header
	}
	cells := make([][]string, len(rows))
	for i, row := range rows {
		obj, ok := row.(map[string]any)
		cells[i] = make([]string, len(cols))
		for j, c := range cols {
			var cell string
			if ok {
				cell = lookup(obj, c.Path)
			} else {
				cell = lookup(row, nil)
			}
			cells[i][j] = clip(sanitize(cell), 80)
		}
	}
	return printAligned(w, headers, cells)
}

func rowArray(payload any, unwrap string) ([]any, error) {
	switch v := payload.(type) {
	case []any:
		return v, nil
	case map[string]any:
		if unwrap != "" {
			inner, ok := v[unwrap]
			if !ok {
				return nil, fmt.Errorf("response has no %q array; use --format json or --raw", unwrap)
			}
			rows, ok := inner.([]any)
			if !ok {
				return nil, fmt.Errorf("%q is not an array; use --format json or --raw", unwrap)
			}
			return rows, nil
		}
	}
	return nil, fmt.Errorf("response is not a list; use --format json or --raw")
}

func lookup(v any, path []string) string {
	if len(path) == 0 {
		return scalar(v)
	}
	cur := v
	for _, key := range path {
		obj, ok := cur.(map[string]any)
		if !ok {
			return ""
		}
		cur = obj[key]
	}
	return scalar(cur)
}

func scalar(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		if t == float64(int64(t)) {
			return fmt.Sprintf("%d", int64(t))
		}
		return fmt.Sprintf("%v", t)
	case bool:
		if t {
			return "true"
		}
		return "false"
	default:
		b, err := json.Marshal(t)
		if err != nil {
			return ""
		}
		return string(b)
	}
}

func sanitize(s string) string {
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\t", " ")
	return s
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	if n <= 3 {
		return s[:n]
	}
	cut := n - 3
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "..."
}

func printAligned(w io.Writer, headers []string, rows [][]string) error {
	widths := make([]int, len(headers))
	for i, h := range headers {
		widths[i] = len(h)
	}
	for _, row := range rows {
		for i, cell := range row {
			if len(cell) > widths[i] {
				widths[i] = len(cell)
			}
		}
	}
	line := func(cells []string) string {
		var b strings.Builder
		for i, cell := range cells {
			if i > 0 {
				b.WriteString("  ")
			}
			b.WriteString(cell)
			if i < len(cells)-1 {
				b.WriteString(strings.Repeat(" ", widths[i]-len(cell)))
			}
		}
		return b.String()
	}
	if _, err := io.WriteString(w, line(headers)+"\n"); err != nil {
		return err
	}
	if len(rows) == 0 {
		_, err := io.WriteString(w, "(no rows)\n")
		return err
	}
	for _, row := range rows {
		if _, err := io.WriteString(w, line(row)+"\n"); err != nil {
			return err
		}
	}
	return nil
}
