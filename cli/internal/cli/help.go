package cli

import "strings"

const rootHelp = `PrivOS operator CLI (read-only)

Usage:
  privos [--format json|table] <command> [flags]
  privos version
  privos --help

Commands:
  sandbox    Sandbox board API (projects, tasks)
  hub        Hub API (rooms, messages, lists, items)
  version    Print the CLI version

privos reads a running sandbox board and hub. It does not install PrivOS,
and it does not send anything except GET. Future write commands must default
to a dry run and require --confirm before a request is sent.

Configuration, auth, and endpoint notes:
  docs/cli/README.md
  docs/api/sandbox.md
  docs/api/hub.md
`

const sandboxHelp = `Usage:
  privos sandbox [--url URL] [--api-key KEY] <command>

Commands:
  projects list    List sandbox projects
  tasks list       List sandbox tasks

Environment (flags override):
  PRIVOS_SANDBOX_URL          Board base URL
  PRIVOS_SANDBOX_API_KEY      API key (preferred)
  API_ACCESS_KEY              Same key; the name the board process uses
  SANDBOX_API_KEY             Same key; the name install.sh writes

The key is sent as the x-api-key header. A default self-hosted board
listens on http://127.0.0.1:8556.

Global flags:
  --format json|table         Default json
  --raw                       Print the response body unchanged
  --timeout SECONDS           HTTP timeout, 1-300 (default 30)
`

const sandboxProjectsListHelp = `Usage:
  privos sandbox projects list [--url URL] [--api-key KEY]

List projects from GET /api/projects.

Environment: PRIVOS_SANDBOX_URL, PRIVOS_SANDBOX_API_KEY
(also API_ACCESS_KEY, SANDBOX_API_KEY).
`

const sandboxTasksListHelp = `Usage:
  privos sandbox tasks list [flags]

List tasks from GET /api/tasks.

Flags:
  --project ID        Limit to one project. Repeat to pass several.
                      Sent as the projectIds query parameter.
  --status STATUS     Filter by status (todo, in_progress, in_review,
                      done, cancelled, or any value the board accepts)
  --limit N           Page size (limit query parameter)
  --after CURSOR      Opaque cursor (position,updatedAt,id)
  --url URL           Board base URL
  --api-key KEY       x-api-key value

Environment: PRIVOS_SANDBOX_URL, PRIVOS_SANDBOX_API_KEY
(also API_ACCESS_KEY, SANDBOX_API_KEY).
`

const hubHelp = `Usage:
  privos hub [--url URL] [--user-id ID] [--auth-token TOKEN] <command>

Commands:
  rooms list              List rooms you belong to (GET /api/v1/rooms.get)
  messages list           List messages in one room
  lists list|get          Reserved. Not wired to a live request yet
  items list|get          Reserved. Not wired to a live request yet

Environment (flags override):
  PRIVOS_HUB_URL          Hub base URL
  PRIVOS_ROOT_URL         Used when PRIVOS_HUB_URL is unset (installer)
  PRIVOS_HUB_USER_ID      X-User-Id
  PRIVOS_HUB_AUTH_TOKEN   X-Auth-Token

A default self-hosted hub listens on http://127.0.0.1:3000
(PRIVOS_HUB_PORT). Create a personal access token in the hub UI, or
POST /api/v1/login, and pass that user id and token. The CLI does not
log in and does not read passwords.

Global flags: --format json|table, --raw, --timeout SECONDS.
`

const hubRoomsListHelp = `Usage:
  privos hub rooms list [--updated-since RFC3339] [--url URL]
                        [--user-id ID] [--auth-token TOKEN]

GET /api/v1/rooms.get. The table view prints the "update" array
(rooms for this user). The "t" field is the room type:
  c  channel (public)   use: privos hub messages list --kind channel
  p  private group      use: privos hub messages list --kind group
  d  direct message     use: privos hub messages list --kind direct

Environment: PRIVOS_HUB_URL or PRIVOS_ROOT_URL, PRIVOS_HUB_USER_ID,
PRIVOS_HUB_AUTH_TOKEN.
`

const hubMessagesListHelp = `Usage:
  privos hub messages list --room ROOM_ID [--kind channel|group|direct]

GET one of:
  channel (c)   /api/v1/channels.messages
  group (p)     /api/v1/groups.messages
  direct (d)    /api/v1/im.messages

--kind defaults to channel. Aliases: c, p, d, private, im, dm.

Flags:
  --room ROOM_ID     Required
  --kind KIND        Room type, default channel
  --count N          Page size (omitted unless set)
  --offset N         Skip this many messages (omitted unless set)
  --url URL
  --user-id ID
  --auth-token TOKEN

Environment: PRIVOS_HUB_URL or PRIVOS_ROOT_URL, PRIVOS_HUB_USER_ID,
PRIVOS_HUB_AUTH_TOKEN.
`

const hubListsHelp = `Usage:
  privos hub lists <command>

Commands:
  list [--room ROOM_ID]    Reserved read for lists.*
  get --id LIST_ID         Reserved read for one list

Not wired to a live request yet: these commands parse flags and do not
send an HTTP request. The hub REST method names for lists are not
confirmed yet. See docs/api/hub.md.

Auth, once wired: X-User-Id and X-Auth-Token
(PRIVOS_HUB_USER_ID, PRIVOS_HUB_AUTH_TOKEN).
`

const hubListsListHelp = `Usage:
  privos hub lists list [--room ROOM_ID]

Reserved. Not wired to a live request in this version.
No HTTP request is sent. See docs/api/hub.md.
`

const hubListsGetHelp = `Usage:
  privos hub lists get --id LIST_ID

Reserved. Not wired to a live request in this version.
No HTTP request is sent. See docs/api/hub.md.
`

const hubItemsHelp = `Usage:
  privos hub items <command>

Commands:
  list --list LIST_ID    Reserved read for items in one list
  get --id ITEM_ID       Reserved read for one item

Not wired to a live request yet: these commands parse flags and do not
send an HTTP request. See docs/api/hub.md.
`

const hubItemsListHelp = `Usage:
  privos hub items list --list LIST_ID

Reserved. Not wired to a live request in this version.
No HTTP request is sent. See docs/api/hub.md.
`

const hubItemsGetHelp = `Usage:
  privos hub items get --id ITEM_ID

Reserved. Not wired to a live request in this version.
No HTTP request is sent. See docs/api/hub.md.
`

const versionHelp = `Usage:
  privos version

Print the CLI version.
`

func helpFor(path []string) string {
	switch strings.Join(path, " ") {
	case "":
		return rootHelp
	case "sandbox":
		return sandboxHelp
	case "sandbox projects":
		return "Usage:\n  privos sandbox projects list\n\n" + sandboxProjectsListHelp
	case "sandbox projects list":
		return sandboxProjectsListHelp
	case "sandbox tasks":
		return "Usage:\n  privos sandbox tasks list\n\n" + sandboxTasksListHelp
	case "sandbox tasks list":
		return sandboxTasksListHelp
	case "hub":
		return hubHelp
	case "hub rooms":
		return "Usage:\n  privos hub rooms list\n\n" + hubRoomsListHelp
	case "hub rooms list":
		return hubRoomsListHelp
	case "hub messages":
		return "Usage:\n  privos hub messages list --room ROOM_ID\n\n" + hubMessagesListHelp
	case "hub messages list":
		return hubMessagesListHelp
	case "hub lists":
		return hubListsHelp
	case "hub lists list":
		return hubListsListHelp
	case "hub lists get":
		return hubListsGetHelp
	case "hub items":
		return hubItemsHelp
	case "hub items list":
		return hubItemsListHelp
	case "hub items get":
		return hubItemsGetHelp
	case "version":
		return versionHelp
	default:
		return ""
	}
}
