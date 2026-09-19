export const RELAY_DEPOSITORY: string;
export const RELAY_ROUTER: string;
export type RelayProtocolIntent = {
  user: string; recipient: string; fromChain: number; toChain: number;
  fromCurrency: string; toCurrency: string; amountWei: bigint | string;
  minOutput?: bigint | string;
  allowUnverifiedSolOrigin?: boolean;
  txs?: { to: string; data: string; value?: string | bigint | number }[];
};
export function validateRelayIntent(quote: unknown, intent: RelayProtocolIntent): void;
export function validateRelayProtocol(quote: unknown, intent: RelayProtocolIntent): Promise<{ verified: boolean; orderId?: string; reason?: string; protocolVerified?: boolean; verification?: string }>;

export function validateRelayEvmSteps(quote: unknown, intent: RelayProtocolIntent): { tx: any; expectedInput: bigint; native: boolean };
