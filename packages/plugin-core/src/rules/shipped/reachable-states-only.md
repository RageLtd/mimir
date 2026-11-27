# Handle only the states that can occur

Judge by how the code is called right now, not by how it might be called one day. A guard, fallback or default for a state no caller can produce never runs, and tells the reader it might.

Validate input once, where it enters the program, and trust it after that. A broken contract fails loudly; it is not turned into a default.
