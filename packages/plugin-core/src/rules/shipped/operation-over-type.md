# Organise by operation, not by type

When a few variants meet several operations, write each operation as one function that switches over the variants, and keep what differs between the variants in plain data. Do not build a hierarchy of objects that each carry their own copy of every method.
