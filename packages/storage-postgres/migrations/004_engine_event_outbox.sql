CREATE TABLE lip_engine_event_outbox (
  tenant_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  outbox_id UUID NOT NULL,
  event_source TEXT NOT NULL,
  event_id TEXT NOT NULL,
  subject TEXT,
  event JSONB NOT NULL,
  recipients JSONB NOT NULL CHECK (jsonb_typeof(recipients) = 'array' AND jsonb_array_length(recipients) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, program_id, outbox_id),
  UNIQUE (tenant_id, program_id, event_source, event_id),
  FOREIGN KEY (tenant_id, program_id) REFERENCES lip_engine_states(tenant_id, program_id) ON DELETE CASCADE
);
CREATE INDEX lip_engine_event_outbox_pending ON lip_engine_event_outbox(tenant_id, program_id, created_at, outbox_id);
ALTER TABLE lip_engine_event_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE lip_engine_event_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY lip_tenant_isolation ON lip_engine_event_outbox FOR ALL
  USING (tenant_id = lip_current_tenant()) WITH CHECK (tenant_id = lip_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON lip_engine_event_outbox TO lip_tenant_runtime;
