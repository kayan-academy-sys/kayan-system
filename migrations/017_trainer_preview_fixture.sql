-- Isolated, explicit registry. Names alone never authorize a payout.
CREATE TABLE trainer_preview_fixture (
 id integer PRIMARY KEY CHECK(id=1),
 trainer_id integer NOT NULL UNIQUE REFERENCES trainers(id),
 group_id integer NOT NULL UNIQUE REFERENCES groups(id),
 account_id integer NOT NULL UNIQUE REFERENCES financial_accounts(id),
 created_by integer NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
