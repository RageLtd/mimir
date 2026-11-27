# Do no work the problem does not require

For each allocation, copy, conversion, parse, lookup and round trip, name what in the problem needs it. If nothing does, it goes.

- One pass over the data, not one per step.
- One batch, not a call per item.
- Parse a value once, where it arrives, and pass the parsed form on.

This is not optimisation and needs no measurement. It is leaving out work nobody asked for.
