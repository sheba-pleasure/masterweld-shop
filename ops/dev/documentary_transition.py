"""Coordinate 0042 without retrying a database write or starting an incompatible app."""


def execute(io, record, apply=False):
    """io is the checked DEV adapter; persist precedes each irreversible boundary."""
    if apply:
        if record["phase"] != "prepared":
            raise RuntimeError("DOCUMENTARY_TRANSITION_ALREADY_STARTED")
        io.persist(record, "draining")
        try:
            io.pause_writers(record)
        except Exception:
            # No migration was submitted. Restoration still checks current schema.
            io.persist(record, "drain_failed")
            io.restore_before_migration(record)
            raise
        io.persist(record, "migration_submitted")
        try:
            io.migrate(record)
        except Exception as error:
            # SQL, network and process failures share an uncertain boundary.
            # Never guess that COMMIT failed; never replay or restore the old app here.
            io.persist(record, "migration_requires_review")
            raise RuntimeError("DOCUMENTARY_COMMIT_REQUIRES_REVIEW") from error
    # Explicit finish is read-only with respect to the migration, even after a crash.
    io.confirm_commit(record)
    io.persist(record, "migration_recorded")
    try:
        io.activate(record)
    except Exception as error:
        io.persist(record, "activation_requires_review")
        raise RuntimeError("DOCUMENTARY_ACTIVATION_REQUIRES_REVIEW") from error
    io.persist(record, "application_ready")
    try:
        io.resume_worker(record)
    except Exception as error:
        io.persist(record, "worker_requires_review")
        raise RuntimeError("DOCUMENTARY_WORKER_REQUIRES_REVIEW") from error
    io.persist(record, "complete")
    return record
