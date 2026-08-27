CREATE TABLE IF NOT EXISTS devices (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  location VARCHAR(160) NOT NULL DEFAULT '',
  oil_unit VARCHAR(12) NOT NULL DEFAULT 'L',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lubrication_records (
  id BIGSERIAL PRIMARY KEY,
  device_id BIGINT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  amount NUMERIC(12,3) NOT NULL CHECK (amount > 0),
  remark VARCHAR(200) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lubrication_records_device_time
ON lubrication_records(device_id, created_at DESC);

INSERT INTO devices(code, name, location) VALUES
('SB001','电力测功器','试车一线'),
('SB002','辅助支撑','试车一线'),
('SB003','液压站','试车一线'),
('SB004','设备4','试车一线'),
('SB005','设备5','试车一线')
ON CONFLICT(code) DO NOTHING;
