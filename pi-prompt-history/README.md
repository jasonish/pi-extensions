# pi-prompt-history

Search your **user prompt history across all sessions** with a keyboard shortcut.

## Shortcut

- `Ctrl+Alt+R` — open prompt history search

## Behavior

1. Press `Ctrl+Alt+R`
2. A live-search picker opens
3. Type to fuzzy-filter results (fzf-style)
4. Press Enter to load the selected prompt into the editor

On first load (or cache refresh), a loading panel shows indexing progress.
Current session prompts are merged in immediately, so new prompts appear without waiting for cache expiry.

## Result Ordering

- Results are shown in **recency order** (newest first)
- Filtering does **not** reorder by fuzzy score; it only filters matches

No slash commands are added.

## License

MIT
