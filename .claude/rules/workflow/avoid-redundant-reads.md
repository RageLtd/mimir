# Avoid Redundant Reads

Do not re-read files that were already read in this conversation unless they have been edited since the last read.

- **Unmodified file**: Reference the prior read. Do not call the Read tool again.
- **File you edited**: Re-read only if you need to verify the edit or see surrounding context you didn't capture before.
- **After an external process ran** (formatter, build step, package manager, etc.): When in doubt about whether a file was modified externally, re-read it.

Each redundant read wastes context tokens and slows down the conversation. One informed read is enough.
