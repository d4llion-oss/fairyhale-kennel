#!/bin/sh
# Migrate + seed are idempotent. If they fail we still start the server so the
# runtime logs and console remain reachable for diagnosis; /healthz reports DB state.
node src/db/migrate.js || echo "WARNING: migration failed; starting server anyway"
node src/db/seed.js || echo "WARNING: seed failed; starting server anyway"
exec node src/server.js
