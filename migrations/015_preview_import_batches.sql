CREATE TABLE preview_import_batches (
 id BIGSERIAL PRIMARY KEY,
 digest TEXT NOT NULL UNIQUE,
 created_by INT REFERENCES users(id),
 summary JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
