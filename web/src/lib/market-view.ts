/** JSON shape of a market snapshot sent to the browser (no bigint, no personal data). */
export interface MarketView {
  version: string;
  bids: { price: number; tokens: number; orders: number }[];
  asks: { price: number; tokens: number; orders: number }[];
  trades: { id: string; at: string; price: number; tokens: number; tx: string | null }[];
  candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[];
  last: number | null;
  volume24h: number;
}
