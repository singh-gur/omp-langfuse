# Usage: `just <task>`. Run `just` to list tasks.

# List available tasks
default:
    @just --list

# Install dependencies
install:
    pnpm install

# Type-check sources and tests
typecheck:
    pnpm run typecheck

# Run unit tests only (no omp binary needed)
test-unit:
    pnpm run test:unit

# Run all tests, including integration tests against the installed `omp` (override with OMP_BIN)
test:
    pnpm test

# Symlink this checkout into ~/.omp/plugins so every omp session loads it
link:
    omp plugin link {{justfile_directory()}}

# Remove the linked plugin again
unlink:
    omp plugin uninstall omp-langfuse

# Run omp once with this checkout loaded, without installing it
try *ARGS:
    omp -e {{justfile_directory()}}/src/index.ts {{ARGS}}
