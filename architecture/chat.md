# The assistant drawer

How the assistant module's chat works, from the drawer to the model.

The chat drawer (assistant's `ui/components/`, the `/chat` route in the drawer) is the fifth way of asking: a question in words, answered by
the archive's own commands. On the chat page (`/chat`), which is the same conversation at full size, the
drawer is collapsed and the header's chat button hidden; `drawerPath` is kept, so on a wide screen
leaving the page brings the drawer back as it was. The drawer shows one chat, without tabs: the one
last open, or else the latest. The top bar's chat button closes it, so its own X is shown only beside
the lightbox, which covers the top bar. Beside the page it has a hairline on its left and the
patterned bar the chat page has; where it is the whole width, neither. Its backend is one command, [`assistant-ask`](../bin/assistant-ask)
in the `assistant` module, sent over the ordinary api-shell `exec` with what the page is showing
(`--context`: the page's route and the lightbox picture, read from the page's router, since the chat is often in the drawer beside it, and what the page is — the sidebar entry it is under and the title and node it declares, `pageShown()`). A page declares its subject with the kit's `usePageSubject({ title, about, node })`, which `EntityDetailHeader` calls with the page's name (its `name`, or the text written out in its `title`; a title drawn by a component of its own says its name with `name`), its subtitle's text and `path`, so every page it heads says what it is; only a page does, not a dialog or the drawer, and keyed by its path, so a page still drawn while the next one loads is not taken for it. The command stamps the user's message with it in words — `on screen: People › Anna Andersson, "…", ?tab=family, about node /archive/people/…` — leaving out a named page's address, which the model would take for a node path and search the tree for; a page with no name goes by its address, and the system text says a screen is the app's, never a node to `ls`. With a durable chat (`--chat`), the command reads the earlier turns from
the chat log itself, and with them the pictures earlier answers showed: the fast path asks the
search for a page large enough to drop those and still fill the answer, and a `search` in the
loop leaves them out of the pictures an answer shows, which is what makes "fler bilder" new ones
(a client without a chat log may pass `shown` in the context instead).

The same workspace is also the chat page, at `/chat/<id>` so a conversation can be linked to:
plain `/chat` opens the latest and takes its id into the URL, switching chats moves the URL
along, and the drawer's title, a link, goes to the page on the chat it shows (`surface.openPage`). The URL
follows the active chat only once the chat it names is open, or the latest would take the link
over (`ChatWorkspace`'s `chatId` and `onChatChange`). The page opens with the slim hat-field bar
(`PageBar`) holding its title and the new-chat button. Beside the chat on a wide screen the recent
chats are a bordered box in the page's margin (`ChatHistoryPane`), as Settings' lists are; a
phone has no room for it, so its bar adds a menu of the chats instead. On a
phone the input, its think and send buttons and the bar's buttons are finger-sized, as the app
header's are. The drawer's own words are English; the
conversation is in whatever language the user writes.

Behind it is a bounded loop over the chat model, Qwen3.5-4B
(`modules/assistant/lib/agent.ts`), which knows no module: what it offers and says comes from the
modules' drop-ins, each module's `etc/assistant.d/` linked as `/etc/assistant.d/<module>/`
(`lib/drop-ins.ts`). The model's tools are the commands the modules list there (`tools`, one a
line): the assistant's own the VFS readers `ls`, `stat`, `find` and `cat` (a log with `cat -t`, each
entry after its time, so a weight series comes with its dates), archive's the ones its questions
need most — `search`, `search-people`, `person-info`, `person-relatives`, `location-region`,
`media-details`, core's `events` and others. Each is described to the model by its own `--help` spec
(`toolSchema`), so a command is offered as it describes itself and nothing is kept in step by hand
— plus `final_answer`. The model calls one in its native tool-call format, the code runs the line
as the user and hands back what the command printed, and asks again. The rules live in
`/etc/assistant-prompt.md` (shipped by the module, never overwritten once edited) so whoever runs
the archive can change them: how to work, the node types every instance has, the reply. Each
module's `prompt.md` follows it — archive's says where people, albums and locations live and which
of its commands answers what. `cat` is not
read-only on every type, so the loop refuses it on a queue (reading takes the messages) and a router
(reading waits for the next one) before it runs. A call repeated with the same arguments gets its
error result and then a user-role "answer now", which is what stops the model re-reading. After a
third repeat in a row the model is asked once more, once a turn, without thinking and offered only
`final_answer`, to answer from the results it has; anything but an answer then ends the turn. An answer
cut at the token limit (2048 a call) is the `too-long` failure, shown as "Answer too long", rather
than an empty bubble.

The rest of EiN — services, pipelines, jobs, users, modules, settings, about three hundred
commands in all — is reached without offering each as a tool. `find_commands` searches an index
of every command on the user's PATH by what it should do (`lib/command-index.ts`: core's command
catalogue — each spec from `--help`, kept per user in memory and in `~/.cache/commands.json` — with
a vector of each name and description from the command `CFG_TEXT_EMBEDDER` names — ems's
`ems-text-embed` — ranked by
the vector and by words; the vectors kept in `~/.cache/assistant-commands.json` with the model that
made each, so a query is compared only with its own model's vectors), `command_help` gives one spec, and
`run_command` takes any shell line. Every call — `run_command`'s or a module's tool's — is judged
against the commands' specs (`judgeLine`, see "Command System" in `docs/architecture.md`): a line
that only reads runs at once and its output goes back to the model; a line that changes anything
is never run by the loop and ends the turn as a proposal card with the exact line, run by the
drawer as the user only on their click. The editor, sessions, daemons and the assistant itself are
refused outright. After **Run** or **Decline** the drawer records the outcome and the turn goes on
(`assistant-ask --resume`): the model reads what the line printed — or that it was declined — and
takes the next step, perhaps another proposal, or answers.

The answer is Markdown, and the drawer renders it (`ChatMarkdown.tsx`: the kit's `Markdown`, as the docs pages
use it); a question stays plain text. A link to a path opens that node in the app
(`routeForNode`: a file in the lightbox, anything else by the route its type opens with, `ui.open`),
a web link opens a new tab, and images are never loaded. Before the answer leaves the command,
every path link in it is checked against the VFS as the asker (`lib/answer-links.ts`, parsed by
the same Markdown parser): a node that does not exist or that they cannot see leaves only the
link's words, and each one kept goes with its node's type (`nodeTypes`), which the drawer routes
by.

The trust boundary is the one the search parse set: pictures in the answer are only those a command
this turn listed (with none named, the last search's), links only nodes a result named, by the name
it gave (and, in the text, only nodes the asker can open). Nothing here sorts a path by where it
lives: a result is noted by its `path` and `name`, and a picture by its kind or mimetype. Kin words and ages are the commands' job, not the model's: `person-relatives`
walks the family tree for "mammas syster" and dates "när hon var 6 år", `location-region` turns a
country into the box `search --bbox` takes, and `search --group-by album` counts trips as albums.

Each turn's transcript — every call, result and answer as the model saw them — is stored with
the chat's assistant message and sent back whole on the next turn, with each user message
stamped with its own time and what the app showed. The model is an OpenAI-compatible service
(`lib/llm.ts`, `CFG_LLM_URL`): in production llama.cpp's server in its own `llm` container, which keeps
its cache of what it last read and reads only where a request differs from it. It may be a
provider's instead (`CFG_LLM_PROVIDER`, from the host profile); then the line above the chat's input
names the provider and says that questions, and the names, places and search results read to answer
them, leave the server (`llmNotice`, from `llm-status`); with ours it says nothing. Because the history
goes back exactly as it was sent, and the container's chat template keeps earlier rounds as they
were written, a follow-up reads only the new message. What the model reads
before the conversation — the system message and the tools — is kept on the chat node
(`chatModelContext`) with a checksum, and each assistant message names the checksum it answered
under; when a command or the prompt file has changed since the chat last ran, the new version
replaces the old one at the top of the system message (where the model looks for its tools, not
as a second list further down) and the chat is read once from the start. A plain request for
pictures ("Visa bilder på Erik Lindqvist från 2024") never enters the loop: `lib/fast.ts`
recognises the shape, reads it with core's `parse-search` — whichever module's parser the search
box uses, archive's `archive-parse` asking this model through `CFG_LANGUAGE_MODEL` — and, when every
name resolved and there is a filter to search on, searches once and says so in the parse's own
account of what it found ("Här är 12 bilder på Erik Lindqvist från 2024."). A name the parse could
not resolve, a relation among them, sends the question to the loop.

The reply carries the pictures (rendered with `MediaGrid`, opening the lightbox), the links
(`{ label, path, type }`, routed as the search cards route a hit), the last search in
the search page's own filter vocabulary — the "Show in search" button opens `/search` with every chip
filled, so an interpretation stays inspectable — and the cards the answer asked for.

A card is a module's route drawn under the answer, and the assistant knows none of them. A module
offers its cards in its drop-in, `etc/assistant.d/cards.json` (linked as
`/etc/assistant.d/<module>/`): each a route of its own, a `description` saying when it is wanted,
and `params`, a JSON Schema of what the route takes in its query (a string of `format: path` is a
node). The assistant reads them every turn (`lib/cards.ts`) and offers each as an optional property
of `final_answer`, so the model gives a card in the same call as its answer. What the model fills
in becomes the route's query: a path the asker cannot see is left out, a card missing a required
value or left with nothing is dropped, and a card may name a parameter it is given the answer's
pictures for when the model names none (`fill`). The reply stores `{ id, route }`; the chat draws
the route as a panel (`RoutePanel`), and the module's page fetches what it shows with ordinary
commands as the viewer when it is drawn, so a card shows what the archive says then, and its URL
is a page of its own. Archive offers a family tree (`/family`: `person-graph` of the person and the
people the answer is about, `--only`, or the line of relations to another, `--to`, as the People
page's tree with nothing to expand) and a map (`/map/pins`: `position-get` of the locations and
pictures named, `location-region` of the areas; a picture opens the lightbox, nothing with no
position is drawn, so no coordinate on it is the model's, and it does not zoom on the wheel, so the
chat still scrolls over it). The assistant offers a chart (`/chart`: a log named by its path, read
with `cat -t`, every entry in time order with the log's own unit, or points the model wrote,
drawn as written — numbers from a result, or ones it worked out — by the kit's `Chart` over
`@mantine/charts`; a line whose labels are all dates is spaced by time). An answer with a card
shows no fallback pictures from a search made along the way, unless the card takes the pictures.

A table of many rows is `final_answer`'s own `table`, not a card: the model names the line that
prints the rows (`cat -t <log>`, `… | tail -n 10`), and the code reads them (`lib/table.ts`) — the
output of that line if the turn ran it, else the line run now, when it only reads — so no row passes
through the model, which cannot copy a hundred of them. JSON is a row per object of its longest
list and a column per field; text a row per line, split at tabs, a JSON part spread into its fields.
The rows are stored with the message (`table`, at most a thousand) and drawn as a Mantine `Table`
under the answer with the line that printed them. A line that writes, fails or prints nothing is
said to the model once, and the answer then goes without a table. Above a table, the answer loses
the lines of any list or Markdown table the model wrote into it (`withoutRows`): they repeat the
rows, wrongly. A result of twenty lines, or a JSON list of twenty items, tells the model under it
how to show it as a table; a reply that lists that many rows without asking for a table is given
the table of the last line so told, as is an answer cut at the token limit after such a result.

A turn that did anything is drawn as a Mantine `Timeline`, the way an agent's work reads in
an editor: small coloured dots on a thin grey line, no avatar — a thought (faint, folded to
"Thought for 1.2s", present only when thinking is on), words the model said beside a call, and each
run of commands, folded to one dot ("Ran 3 commands · 0.4s", the thoughts that led to them inside).
Open, a run is its commands as read-only cards in the proposal card's frame: the line, its time, and
what it printed (indented JSON, folded when long, a failure open). Then the answer, then one dot per
card: the proposal, each module's card, the pictures, the links and "Show in search". The words are the model's as written: the prompt
tells it the grid shows the pictures, so it says what they are in a sentence rather than listing
them (measured in `wow/notes/lessons-ui.md`). The reply carries
that order as `timeline` (`AssistantEvent[]`, each command with its line, exit code and first 4000
characters of output), stored with the message, so a reload draws the same thing; a turn stored
before it, or answered by the fast path, is drawn from its `steps`. A plain answer stays plain.
Where the time went closes the bubble, with when it was said as its tooltip (model waits against command time — `timing` in the reply),
because a turn is seconds and the split says which half to work on. The api-shell `exec` still
answers once with the completed reply, but the UI gives the turn a random `--progress` id and
samples `assistant-chat progress` every 400 ms while it runs. That status is private to the
calling uid and ephemeral (`modules/assistant/lib/progress.ts`, in the process's memory, gone with
the completed command), and it is the turn so far: the phase (**Waiting** until the first model
call, then **Thinking**), the timeline, the command line running now, and the model's call in
flight. A watched turn streams each model call (`stream: true` in `llm.ts`), so that draft grows
while the model writes — its thought, the call's name and arguments as they form, and for
`final_answer` the answer's own words, read out of the still-unfinished JSON
(`partialJsonString`). The live bubble is the same timeline: the command running, or the call still being written, folds
into its run as "Running commands…" with the line under it, a loader takes the dot of whatever is
still going on, and a loader dot says "Thinking…" between calls; it follows the text down unless the reader has scrolled up, and the
reply's own timeline replaces it. The bulb beside the input is "think harder": while it is on
(remembered per browser), questions go as `assistant-ask --think`, which turns the model's
thinking on for that turn's calls, gives each call 4096 tokens and skips the fast path; a call
whose thought fills those tokens before it writes anything is asked once more, without thinking,
to answer from the results it has. The question's bubble carries the bulb. It is opt-in because it doubles the wait (measured, see
`wow/notes/lessons-ui.md`). The
command never exits non-zero for a model that will not cooperate or an EMS that is down — it
answers with an English apology, a separate `error` field and a `failure` kind, so a chat
degrades to "not now" rather than a broken request. `failure` is `unavailable` when the model
service could not be reached or the assistant is not set up, and `no-answer` when the model ran
but gave up on the question (it repeated a command, called unknown ones, spent its budget). A model
service that is away — nothing listens, the stream breaks before the first word, a 502–504, or
llama.cpp's 503 while it loads its model — is not unavailable yet: each model call asks it again,
with a growing pause, for up to `CFG_LLM_WAIT` seconds (180, longer than a cold load), while the
live bubble's loader says "The language model is restarting; waiting for it…" (phase `away`), and
the reply's timeline keeps the wait as a line of its own. `llm-chat`, which the search box's parser
asks, does not wait: the parser falls back on its rules. The drawer renders that reply as a red, English-only error card with the technical reason and a
Retry action, titled **Assistant unavailable** or **No answer** by that kind; a turn without it
(a lost request, or one stored before the kind existed) reads as unavailable. The fixed copy also
replaces old bilingual apologies when reading existing transcripts. Retry resubmits the user turn immediately before
the error; because that turn is found in the durable transcript, the action also works after a
reload.

A change goes the same way, up to the point of writing. Every line the model would run — a
command offered as a tool (`person-set-parent`, `person-set-partner`, `person-add-event`,
`file-set-description` and the rest) or a `run_command {command, why}` line — is judged against
the commands' specs, and one that writes is never run by the loop: the turn ends there, the reply's
answer is the code's one line ("Shall I run this?"), and it carries a `proposal` — a title (the
command's description, or `why`), the command line as it is, and the archive paths it names,
people by their names. The drawer renders that as a card (`ProposalCard` in `ChatMessages.tsx`):
**Bash** and the title, the commands as a shell-highlighted block (`CodeMirror` in its gutter-less
`block` chrome) with the title as a `#` comment above its line, a yellow border while it waits,
Run / Decline. The block leads with `set -e` and is editable until then; Run sends the whole
block, comments and all, as one script through `execScript` — the api-shell `exec` with
`json: false`, which runs it without `JSON_OUTPUT` in a subshell (`RunAndCaptureOptions.env`) so
the output is what a terminal would show, not node dumps — with no model in the loop, so a failing
line stops the rest, and what the user sees is exactly what runs (they may take the `set -e`
out). An edited block is recorded as the script that ran (`--script`), so the settled card and the
model's history say what happened rather than what was suggested; the card turns green (Done) or
red (Failed, Declined) and keeps the exit code beside the verdict and the output, stdout then
stderr, under the block — the api-shell's error reply carries `exitCode`, the stdout up to the
failure and the stderr, and `ExecError` in `shell-client.ts` hands them to the caller — and
`usePerson` re-reads the person when `signals/edits.ts` says the archive changed from outside the
page (and `useMediaDetails` the picture). A line naming a command the shell does not have is
refused with similar ones it does, before any card is drawn, as are the editor, sessions, daemons
and the assistant itself. The chat log is append-only, so the decision is a message of its own
(`assistant-chat outcome <chat> <message> ran|failed|dismissed [--results <json>]`) naming the
proposing one; `readChat` joins them into `settled` on the proposal, and the drawer shows the
settled card and no bubble for the outcome message. The turn then goes on (`assistant-ask
--resume`) with the outcome as a note from the app — what the script printed (`It printed:`, cut
at 16 KB) or that it was declined — so the model takes the next step or answers, and "make a table
of that" can be answered from the output. To spell a command it was not given a tool for, the model
finds it with `find_commands` and reads it with `command_help`. The prompt names the user's home
directory so a file asked for with no path lands there.
Message times do not take a line inside either bubble: the user
avatar and assistant robot are keyboard-focusable tooltip targets whose label is the full English
date and 24-hour time. While a response is pending, the loader occupies the robot's avatar slot
instead of sitting beside the phase label.
