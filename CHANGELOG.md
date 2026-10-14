# Changelog

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
