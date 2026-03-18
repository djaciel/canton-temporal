CREATE DATABASE sequencer;
CREATE DATABASE sequencer_driver;
CREATE DATABASE mediator;
CREATE DATABASE participant1;
CREATE DATABASE participant2;
CREATE DATABASE keycloak;
CREATE DATABASE backend_rojo;
CREATE DATABASE backend_azul;

-- Projection tables for backend_rojo
\c backend_rojo;

CREATE TABLE contract_events (
    id SERIAL PRIMARY KEY,
    event_type TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    template_id TEXT NOT NULL,
    choice TEXT,
    consuming BOOLEAN DEFAULT FALSE,
    payload JSONB,
    offset_value BIGINT NOT NULL,
    effective_at TIMESTAMPTZ,
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE active_contracts (
    contract_id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE consumer_state (
    id TEXT PRIMARY KEY DEFAULT 'main',
    last_offset BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO consumer_state (id, last_offset) VALUES ('main', 0);

-- Projection tables for backend_azul
\c backend_azul;

CREATE TABLE contract_events (
    id SERIAL PRIMARY KEY,
    event_type TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    template_id TEXT NOT NULL,
    choice TEXT,
    consuming BOOLEAN DEFAULT FALSE,
    payload JSONB,
    offset_value BIGINT NOT NULL,
    effective_at TIMESTAMPTZ,
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE active_contracts (
    contract_id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE consumer_state (
    id TEXT PRIMARY KEY DEFAULT 'main',
    last_offset BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO consumer_state (id, last_offset) VALUES ('main', 0);
