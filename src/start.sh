#!/bin/sh
set -e
node src/db/migrate.js
node src/db/seed.js
exec node src/server.js
