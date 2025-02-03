
export interface BotMsgResult {
  title: string;
  content: {
    text: string;
    callback_data: string;
  }[][];
}

export interface UserSettingData {
  username: string;
  userId: Number;
  privateKey: string;
  publicKey: string;
  snipingTokens: string[];
  copyingWallets: string[];
  limitOrders: string;
  snipingSolAmount: Number;
  buyIntervalMax: Number;
  buyIntervalMin: Number;
  tokenAddress: string[];
  sellToken: string[];
}

