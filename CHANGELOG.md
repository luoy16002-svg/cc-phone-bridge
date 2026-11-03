# Changelog

## 1.7.0 (2026-11-03)

- **A message typed into a window on the computer no longer shows as not delivered when it was.** A window often writes the message down before the typing has even finished; the bridge took it back at once, and then reported it as not delivered twelve seconds later anyway. Every message the phone typed into a window was affected. Now it is shown and watched for before the typing starts.
- **No more messages stuck "on their way" at the bottom.** A phone that slept or lost its connection missed the notice that a message had arrived, and kept showing it forever. On reconnecting, the phone now drops what the computer no longer lists as on its way, and a message's later state (queued in the window, not delivered) replaces the one it first showed.
- **Days are marked once.** A step dated earlier than the newest ones (from a run of the phone's own, or written late) went to the bottom and brought "Yesterday" back under "Today"; every redraw then left another pair of day marks behind, until the screen filled with them. Steps now go where their time puts them, a day is marked once where it begins, and a redraw never leaves an element behind.
- **The effort follows the window.** The phone shows the model and effort a Claude Code window on the computer runs with, read from its transcript, and changes as soon as `/effort` is used in that window. Setting the effort on the phone sets it in the window for that window only, with Claude Code's own `/effort` slider and its "this session only" key, mid-turn too. The model stays the window's: in Claude Code `/model` also changes the default for new sessions, so the phone leaves that to a `/model` you send on purpose.
- **A window running a command counts as working.** Claude Code reports a running shell step as its own status; the phone took that for idle.
- **Slash commands sent to a window keep what is in its box.** Claude Code gives the box back once a command is done; the bridge used to stash it again by mistake. It now waits for the window to write the command down and only takes off the letter it added.
- Tests: the fake window can write a message down before the typing ends; `npm run test:page` drives the phone page in WebKit through a proxy that cuts the connection; `npm run test:window-real` runs a real Claude Code window in a pseudo console, with nothing on the screen.

## 1.6.0 (2026-10-30)

- **DeepSeek Harness.** When the desktop app is installed, its conversations join the list, marked DeepSeek. Read them in full, follow a turn running on the computer, carry them on, stop them, start new ones, and answer a step that asks first. Turns from the phone run in the harness's own SDK runtime, with what you set up for the desktop app (your own providers too) and the conversation's own permissions; the model list shows the models your conversations use.
- A harness session has one writer at a time, and the desktop app keeps the ones it has opened. The phone says so and keeps your draft; it can write once the app has let go. New conversations are never affected, and the phone gives a session back seconds after each turn, so the computer can pick it up at once.
- **See what the agent saw.** Pictures an agent read show right under its steps, for Claude Code, Codex and DeepSeek Harness alike, and pictures sent in a conversation show as pictures in its history instead of a count.
- Pictures travel by reference: each is kept once on the computer under the hash of its bytes, fetched when it scrolls near the screen and cached by the phone for good. Long conversations stay light. `limits.imageMB` caps the copies (default 1024); opening a conversation again brings back any that were cleared.

## 1.5.0 (2026-10-30)

- **The phone and a window on the computer stay one conversation.** When a Claude Code conversation is open in a window on the computer, what you send from the phone is typed into that window: the window runs the turn and shows it, and nothing runs beside it, so the two can no longer drift into two versions of the conversation. A message sent while a turn runs joins the window's own queue. Whatever sits in the window's box is kept. If the window is waiting for an answer, the phone says so; if it cannot be reached, the phone asks before going on in the background.
- **Leave the page and come back.** The work runs on the computer whether the phone is looking or not. Back on the page, however you got there, the conversation catches up on what it missed; the phone reopens the conversation you were in if the system closed the app meanwhile.
- **Connections that die without saying so are noticed.** A phone that sleeps or changes network can leave a connection hanging with no error, and the page then showed nothing new. The computer now sends something every ten seconds, and the page replaces a connection that goes quiet and catches up.
- **A message goes through once.** A send whose answer never came is tried again by itself, and resending the same draft by hand is safe: the computer runs one message once. A message reported as not delivered that lands late after all is taken back.
- **Replies do not get stuck.** If Claude Code's output stalls, the reply still reaches the phone from the transcript.
- **The note at the end of a turn is more reliable.** An open connection no longer counts as looking at the page, so a phone that was put away gets its note. Turns the phone started in a window on the computer get a note too.
- A conversation left idle is no longer closed while background work it started is still running.

## 1.4.1 (2026-10-23)

- The list shows every Codex conversation once. It used to scan Codex's rollout files when the server started and every five minutes, and a scan lists a conversation once for each file it has, so cards came up twice and others dropped out of the list. It now reads Codex's state database, as the Codex app does, and scans only when the database is empty.

## 1.4.0 (2026-10-23)

- **Branches.** Every message you sent has a branch button: a new conversation keeps what came before it, with the message ready to edit and send. The menu branches the whole conversation. The original stays as it was, and the branch says where it came from. Claude Code branches with `--fork-session` (cut at the message with `--resume-session-at`), Codex with its own `thread/fork`.
- **The Codex app and the phone stay connected.** The Codex app keeps every conversation it has shown loaded for hours, and Codex lets one program write a conversation at a time. Duty Desk now watches Codex's lock files: the phone shows at once when the Codex app has a conversation open, and what you send then goes to a branch that carries the history and appears in the Codex app's list. When the computer lets go, the phone writes the same conversation again.
- Turns running on the computer reach the phone the moment the file changes, for Claude Code and Codex alike (they used to wait up to a second and a half).
- The phone lets go of a Codex conversation cleanly after its turn, so Codex finds no stale lock behind.
- Changing a conversation's model or effort no longer forgets other things kept about it.
- The screenshot script uses a fake Codex in a throwaway folder and swaps the temporary paths for example ones, so screenshots never show your own conversations or user name.
- Tests: `npm run test:codex-real` runs the real Codex CLI against a local stand-in for the model, with a second Codex app server playing the Codex app.

## 1.3.1 (2026-10-23)

- The list opens faster with many Codex conversations: it reads Codex's state database and scans the rollout files only every few minutes.

## 1.3.0 (2026-10-23)

- **Codex.** When the Codex CLI is installed, the conversations of the Codex app and the `codex` CLI join the list, marked Codex, with a switch to see one kind at a time. Read them in full (thinking summaries fold into the steps), carry them on, stop them, or start new ones with Codex's own models and efforts. Replies stream in word by word.
- A Codex turn running on the computer shows on the phone as it happens, and the phone waits for it before sending.
- Codex lets one program at a time write a conversation, so the phone lets go a few seconds after its turn: the same conversation opens in the Codex app or the CLI right away. If the Codex app has it open, the phone says so.
- Settings show the Codex version and its defaults. New keys: `codex.enabled`, `codex.command`, `codex.home`, `codex.resumeCommand`.

## 1.2.0 (2026-10-15)

- **Suggestions.** Another program on the computer (a job watcher, a build bot, a reminder script) can write a small JSON file of things worth starting. They show at the top of the desk; tap Start and the conversation begins in that program's folder with the prompt it wrote. Dismissed or expired suggestions go away. Nothing starts without a tap. Set `suggestions.file` to turn it on.

## 1.1.0 (2026-10-14)

- Pick a folder for a new conversation by tapping through your folders, and make a new one where you are. No more typing paths.
- Effort is shown with Claude Code's own names: `low`, `medium`, `high`, `xhigh`, `max`.
- On iPhone the keyboard no longer pushes the page off the screen, and text boxes no longer zoom the page.
- A conversation running in a terminal on the computer shows on the phone as it happens. The list says which conversations are open or working on the computer.
- Each turn shows how long it took and which model ran it; tool steps are counted by kind and timed; days are marked; working conversations come first.
- Themes: Clear Sky (light) and Night Flight (dark), following the phone, chosen per device. A theme is a folder of colours and drawings.
- English and Chinese, chosen per device.
- Everything machine-specific moved to a config file. Optional HTTPS. Folder access is limited to configured roots, with links resolved. Notifications leave out the conversation by default. The permission mode follows Claude Code's own settings unless configured.
- Fewer disk writes; logs and pictures from the phone are capped.
- Runs on Linux as well as Windows (tested); macOS should work but is untested.

## 1.0.0 (2026-10-14)

- First version: pairing with a code, the list of the computer's Claude Code conversations, the history with tool calls folded, carrying on and starting conversations, model and effort, pictures, notifications.
