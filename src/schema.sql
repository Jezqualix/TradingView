-- TradingView x Claude — Database Schema

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'signals')
CREATE TABLE signals (
  id          BIGINT IDENTITY(1,1) PRIMARY KEY,
  symbol      VARCHAR(20)    NOT NULL,
  action      VARCHAR(10)    NOT NULL,
  price       DECIMAL(18,8)  NOT NULL,
  interval    VARCHAR(10)    NULL,
  rsi         DECIMAL(5,2)   NULL,
  macd        DECIMAL(10,6)  NULL,
  ema_fast    DECIMAL(18,8)  NULL,
  ema_slow    DECIMAL(18,8)  NULL,
  raw_payload NVARCHAR(MAX)  NULL,
  received_at DATETIME2      NOT NULL DEFAULT GETDATE()
);

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'decisions')
CREATE TABLE decisions (
  id               BIGINT IDENTITY(1,1) PRIMARY KEY,
  signal_id        BIGINT         NOT NULL REFERENCES signals(id),
  decision         VARCHAR(10)    NOT NULL,
  confidence       TINYINT        NOT NULL,
  reasoning        NVARCHAR(MAX)  NULL,
  risk_notes       NVARCHAR(MAX)  NULL,
  matched_strategy VARCHAR(100)   NULL,
  tokens_used      INT            NULL,
  decided_at       DATETIME2      NOT NULL DEFAULT GETDATE()
);

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'positions')
CREATE TABLE positions (
  id           BIGINT IDENTITY(1,1) PRIMARY KEY,
  decision_id  BIGINT         NOT NULL REFERENCES decisions(id),
  symbol       VARCHAR(20)    NOT NULL,
  side         VARCHAR(5)     NOT NULL,
  amount_usd   DECIMAL(18,2)  NOT NULL,
  entry_price  DECIMAL(18,8)  NOT NULL,
  exit_price   DECIMAL(18,8)  NULL,
  pnl_usd      DECIMAL(18,2)  NULL,
  status       VARCHAR(10)    NOT NULL DEFAULT 'OPEN',
  opened_at    DATETIME2      NOT NULL DEFAULT GETDATE(),
  closed_at    DATETIME2      NULL
);

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'portfolio')
CREATE TABLE portfolio (
  id               BIGINT IDENTITY(1,1) PRIMARY KEY,
  starting_balance DECIMAL(18,2) NOT NULL,
  current_balance  DECIMAL(18,2) NOT NULL,
  total_trades     INT           NOT NULL DEFAULT 0,
  winning_trades   INT           NOT NULL DEFAULT 0,
  snapshot_at      DATETIME2     NOT NULL DEFAULT GETDATE()
);

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'strategies')
CREATE TABLE strategies (
  id               BIGINT IDENTITY(1,1) PRIMARY KEY,
  name             VARCHAR(100)   NOT NULL,
  description      NVARCHAR(MAX)  NULL,
  indicators       NVARCHAR(500)  NULL,
  asset_type       VARCHAR(10)    NOT NULL,
  claimed_win_rate DECIMAL(5,2)   NULL,
  skepticism_score TINYINT        NULL,
  source_url       NVARCHAR(500)  NULL,
  last_updated     DATETIME2      NOT NULL DEFAULT GETDATE()
);

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'claude_memory')
CREATE TABLE claude_memory (
  id         BIGINT IDENTITY(1,1) PRIMARY KEY,
  symbol     VARCHAR(20)    NULL,
  asset_type VARCHAR(10)    NULL,
  insight    NVARCHAR(MAX)  NOT NULL,
  source     VARCHAR(20)    NOT NULL,
  confidence TINYINT        NULL,
  created_at DATETIME2      NOT NULL DEFAULT GETDATE()
);

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'tickers')
CREATE TABLE tickers (
  id         BIGINT IDENTITY(1,1) PRIMARY KEY,
  symbol     VARCHAR(20)   NOT NULL UNIQUE,
  name       VARCHAR(100)  NULL,
  asset_type VARCHAR(10)   NOT NULL DEFAULT 'STOCK',
  exchange   VARCHAR(50)   NULL,
  is_active  BIT           NOT NULL DEFAULT 1,
  created_at DATETIME2     NOT NULL DEFAULT GETDATE()
);
