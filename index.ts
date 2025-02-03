import "dotenv/config";
import TelegramBot, { CallbackQuery } from 'node-telegram-bot-api';

import * as commands from './commands'
import { BOT_TOKEN } from "./config";
import { connectMongoDB } from "./database/db";
import { BotMsgResult, sleep } from "./utils";

import { Commitment, Connection, PublicKey } from "@solana/web3.js";
import { COMMITMENT, RPC_ENDPOINT, RPC_WEBSOCKET_ENDPOINT } from "./config";
import { bottleneck } from "./utils/bottleneck";
import { helper } from "./database";
import { SellToken } from "./database/helper";
import { Types } from "mongoose";

const token = BOT_TOKEN
const connection = new Connection(RPC_ENDPOINT);
const bot = new TelegramBot(token!, { polling: true });
let botName: string
let editText: string


const commitment: Commitment =
    COMMITMENT === "processed" ? "processed" :
        COMMITMENT === "confirmed" ? "confirmed" : "finalized";

export const solanaConnection = new Connection(RPC_ENDPOINT, {
    wsEndpoint: RPC_WEBSOCKET_ENDPOINT, commitment
})

bot.getMe().then(user => {
    botName = user.username!.toString()
})

bot.setMyCommands(commands.commandList)

connectMongoDB()

bot.on(`message`, async (msg) => {
    const chatId = msg.chat.id!
    const text = msg.text!
    const msgId = msg.message_id!
    const username = msg.from!.username!

    if (text) console.log(`message : ${chatId} -> ${text}`)
    else return
    try {
        let result
        switch (text) {
            case `/start`:
                let mainWallet = await helper.findOne(chatId);

                if (mainWallet?.publicKey && mainWallet?.publicKey !== "" && mainWallet?.privateKey && mainWallet?.privateKey !== "") {
                    result = await commands.welcomeDashboard(chatId, username)
                    rateLimitedSendMessage(
                        chatId,           // Chat ID
                        result.title,     // Text message to send
                        {
                            reply_markup: {
                                inline_keyboard: result.content // Inline keyboard markup
                            },
                            parse_mode: 'HTML', // HTML formatting mode
                            disable_web_page_preview: true // Disable link previews
                        }
                    )
                } else {
                    result = await commands.welcome(chatId, username)
                    rateLimitedSendMessage(
                        chatId,           // Chat ID
                        result.title,     // Text message to send
                        {
                            reply_markup: {
                                inline_keyboard: result.content // Inline keyboard markup
                            },
                            parse_mode: 'HTML', // HTML formatting mode
                            disable_web_page_preview: true // Disable link previews
                        }
                    )
                }
                break;
            default:
                await bot.deleteMessage(chatId, msgId)
        }
    } catch (e) {
        console.log(chatId, ' => Error handling message handling: \n', e)
    }
});

bot.on('callback_query', async (query: CallbackQuery) => {
    const chatId = query.message?.chat.id!
    const msgId = query.message?.message_id!
    const action = query.data!
    const username = query.message?.chat?.username!
    const callbackQueryId = query.id;

    console.log(`query : ${chatId} -> ${action}`)
    try {
        let result
        switch (action) {

            case 'back-to-main':
                result = await commands.welcomeDashboard(chatId, username)
                await sendMessage(result, msgId, chatId)
                break;

            case 'sniping':
                result = await commands.lpDashboard(chatId, username)
                await sendMessage(result, msgId, chatId)
                break;

            case 'delete-all-sniper-token':
                const isDeleted = await helper.deleteAllSnipingTokens(chatId);

                if (isDeleted) {
                    // Refresh UI after deleting all tokens
                    const result = await commands.lpDashboard(chatId, username);
                    await sendMessage(result, msgId, chatId);
                } else {
                    await bot.sendMessage(chatId, "❌ No tokens found to delete.");
                }
                break;

            case 'set-sniping-token':
                const sendTokenAddrMsgs = await bot.sendMessage(
                    chatId, '💼 Please send a valid Solana token address.'
                );

                bot.once(`message`, async (msg) => {
                    if (msg.text) {
                        const tokenAddress = msg.text.trim();

                        // ✅ Validate Solana token address
                        const isValid = await helper.validateTokenAddress(tokenAddress);
                        if (!isValid) {
                            await bot.sendMessage(chatId, "❌ Invalid token address! Please enter a correct Solana token address using only Base58 characters.");
                            const lpDashboard = await commands.lpDashboard(chatId, username);
                            await sendMessage(lpDashboard, msgId, chatId, true);
                            return;
                        }

                        // ✅ Check if token is already in the database
                        const isDuplicate = await helper.isTokenAlreadyAdded(chatId, tokenAddress);
                        if (isDuplicate) {
                            await bot.sendMessage(chatId, "⚠️ You are already running a sniper on this token.");
                            const lpDashboard = await commands.lpDashboard(chatId, username);
                            await sendMessage(lpDashboard, msgId, chatId, true);
                            return;
                        }

                        // 🟢 If valid and new, proceed with adding the token
                        result = await commands.addSnipingToken(chatId, username, tokenAddress);
                        await sendMessage(result, msgId, chatId, true);
                        await bot.deleteMessage(chatId, sendTokenAddrMsgs.message_id);
                    }
                });
                break;

            case 'sniper-wallets':
                result = await commands.snipingWalletList(chatId, username)
                await sendMessage(result, msgId, chatId)
                break;

            case 'buy-token':
                await bot.sendMessage(chatId, '💼 Please send a valid Solana token address.');

                // ✅ Store state to expect a token address
                helper.setUserState(chatId, 'awaiting_token');

                bot.on("message", async (msg) => {
                    if (msg.chat.id !== chatId) return; // Ensure we process only the intended user request

                    if (helper.getUserState(chatId) !== 'awaiting_token') return; // Only process if the user is in the correct state

                    if (msg.text) {
                        const tokenAddress = msg.text.trim();

                        // ✅ Validate Solana token address
                        const isValid = await helper.validateTokenAddress(tokenAddress);
                        if (!isValid) {
                            await bot.sendMessage(chatId, "❌ Invalid token address! Please enter a correct Solana token address.");
                            const lpDashboard = await commands.welcomeDashboard(chatId, username);
                            await sendMessage(lpDashboard, msgId, chatId, false);
                            return;
                        }

                        if (!chatId || !tokenAddress) {
                            console.error("Missing chatId or tokenAddress");
                            return;
                        }

                        // 🟢 If valid and new, proceed with adding the token
                        result = await commands.buyToken(chatId, username, tokenAddress);
                        await sendMessage(result, msgId, chatId, false);

                        // 🔄 Reset state after successful token input
                        helper.setUserState(chatId, null);
                    }
                });
                break;

            case 'sell-token':
                try {
                    const result = await commands.sellToken(chatId, username);

                    // Ensure result is not undefined
                    if (result) {
                        await sendMessage(result, msgId, chatId);
                    } else {
                        console.error('No result returned from sellToken function');
                        // Optionally, send a default error message
                        await sendMessage(
                            { title: 'Error', content: [[{ text: '❌ Something went wrong, please try again later.', callback_data: 'error' }]] },
                            msgId,
                            chatId
                        );
                    }
                } catch (error) {
                    console.error('Error processing sell-token command:', error);
                    await sendMessage(
                        { title: 'Error', content: [[{ text: '❌ Something went wrong while processing your request.', callback_data: 'error' }]] },
                        msgId,
                        chatId
                    );
                }
                break;

            case action.startsWith('confirm-sell-token-') ? action : '':
                const parts = action.split('-');

                const sellTokenId = parts.length > 3 ? parts.slice(3).join('-') : '';

                result = await commands.selectedSellToken(chatId, username, sellTokenId);
                try {
                    await sendMessage(result, msgId, chatId);
                } catch (error) {
                    console.error("❌ Error sending message:", error);
                }
                break;

            case 'back-to-buy-token':
                result = await commands.welcomeDashboard(chatId, username);
                let saveTokenAddress = "";
                const savedToken = await helper.getUserToken(chatId);
                console.log("savedToken  ==>", savedToken)


                if (savedToken && savedToken.tokenAddress !== "") {
                    saveTokenAddress = savedToken.tokenAddress;
                }

                console.log("address  ==>", saveTokenAddress)

                if (saveTokenAddress) {
                    // ✅ Use previously entered token address (string) for buyToken
                    result = await commands.buyToken(chatId, username, saveTokenAddress);
                    await sendMessage(result, msgId, chatId, false);
                } else {
                    // ⚠️ If no token found, ask for input again
                    await bot.sendMessage(chatId, "💼 Please send a valid Solana token address.");
                    helper.setUserState(chatId, 'awaiting_token');
                }
                break;

            case 'wallet-to-buy':
                // Fetch the available wallets and show them
                result = await commands.selectWallets(chatId, username);
                await sendMessage(result, msgId, chatId);

                // ✅ Listen for callback queries (specifically the back button)
                // bot.on("callback_query", async (callbackQuery) => {
                //     const { data } = callbackQuery;

                //     // Handle when the user presses the "back-to-buy-token" button
                //     if (data === "back-to-buy-token") {
                //         // Check if the user is in the correct state to go back
                //         const userState = await helper.getUserState(chatId); // You should store the user's current state

                //         if (userState === 'select_wallets') {
                //             // Use the saved token address if available
                //             const savedToken = await helper.getUserToken(chatId);

                //             if (savedToken && savedToken.tokenAddress) {
                //                 // ✅ If token address exists, proceed with buying the token
                //                 result = await commands.buyToken(chatId, username, savedToken.tokenAddress);
                //                 await sendMessage(result, msgId, chatId, false);
                //             } else {
                //                 // ⚠️ If no token address is saved, ask for a new token address
                //                 await bot.sendMessage(chatId, "💼 Please send a valid Solana token address.");
                //                 // Update user state to await a new token address
                //                 helper.setUserState(chatId, 'awaiting_token');
                //             }
                //         } else {
                //             // If the user is not in the 'select_wallets' state, handle the flow accordingly
                //             await bot.sendMessage(chatId, "❌ Invalid action. Please try again.");
                //         }
                //     }
                // });
                break;

            case action.startsWith('buy-token-wallet-') ? action : '':
                const butWallet = action.split('-');
                console.log("butWallet ===>", butWallet);
                const buyTokenId = butWallet.length > 3 ? butWallet.slice(3).join('-') : '';

                try {
                    // ✅ Retrieve the user's info from the database
                    const userInfo = await helper.findUser(chatId, username);
                    if (!userInfo) {
                        console.error(`User info not found for chatId: ${chatId}, username: ${username}`);
                        return;
                    }

                    let walletList = userInfo.tokenAddress[0].wallets || [];

                    if (walletList.length <= 0) {
                        // 🟢 If no wallets exist, add the new wallet
                        walletList.push({ address: buyTokenId });
                        console.log(`No wallets found, adding wallet ${buyTokenId}`);
                    } else {
                        // 🔄 Compare each address with buyTokenId
                        const walletIndex = walletList.findIndex(wallet => wallet.address === buyTokenId);

                        if (walletIndex !== -1) {
                            // 🔴 If wallet address found, remove it
                            walletList.splice(walletIndex, 1);
                            console.log(`Removed wallet ${buyTokenId} from the wallets.`);
                        } else {
                            // 🟢 If wallet address not found, add it
                            walletList.push({ address: buyTokenId });
                            console.log(`Added wallet ${buyTokenId} to the wallets.`);
                        }
                    }

                    // ✅ Update the userInfo with the modified wallets array
                    userInfo.tokenAddress[0].wallets = walletList;

                    // ✅ Save the updated user info back to the database
                    await helper.updateUserTokenAddress(chatId, { tokenAddress: userInfo.tokenAddress });

                    // ✅ Fetch the updated wallet selection and send it as a message
                    const result = await commands.selectWallets(chatId, username);
                    await sendMessage(result, msgId, chatId);
                } catch (error) {
                    console.error("❌ Error processing wallet selection:", error);
                }
                break;

            case action.startsWith('buy-token-state-') ? action : '':
                const stateParts = action.split('-');
                const buyState = stateParts.length > 3 ? stateParts.slice(3).join('-') : '';

                try {
                    const userInfo = await helper.findUser(chatId, username);
                    if (!userInfo) {
                        console.error(`User info not found for chatId: ${chatId}, username: ${username}`);
                        return;
                    }

                    // ✅ Get the current buyTokenState
                    let currentState = userInfo.tokenAddress[0]?.buyTokenState || '';

                    // ✅ If state is the same, return early to avoid unnecessary updates
                    if (buyState === currentState) {
                        return;
                    }

                    // ✅ Update the buyTokenState
                    userInfo.tokenAddress[0].buyTokenState = buyState;

                    // ✅ Save the updated user info back to the database
                    await helper.updateUserTokenAddress(chatId, { tokenAddress: userInfo.tokenAddress });

                    // ✅ Fetch the updated buyToken data and send message
                    result = await commands.buyToken(chatId, username, userInfo.tokenAddress[0].address);
                    await sendMessage(result, msgId, chatId);

                } catch (err) {
                    console.error("❌ Error processing buy token state:", err);
                }
                break;

            case action.startsWith('sell-token-state-') ? action : '':
                const sellStateParts = action.split('-');
                const sellState = sellStateParts.length > 3 ? sellStateParts.slice(3).join('-') : '';

                try {
                    const userInfo = await helper.findUser(chatId, username);
                    if (!userInfo) {
                        console.error(`User info not found for chatId: ${chatId}, username: ${username}`);
                        return;
                    }

                    // ✅ Get the current buyTokenState
                    let currentState = userInfo.selectedSellToken[0]?.sellState || '';

                    // ✅ If state is the same, return early to avoid unnecessary updates
                    if (sellState === currentState) {
                        return;
                    }

                    // ✅ Update the buyTokenState
                    userInfo.selectedSellToken[0].sellState = sellState;

                    // ✅ Save the updated user info back to the database
                    await helper.updateUserSelectedSellToken(chatId, { selectedSellToken: userInfo.selectedSellToken });

                    // ✅ Fetch the updated buyToken data and send message
                    result = await commands.selectedSellToken(chatId, username, userInfo.selectedSellToken[0].address);
                    await sendMessage(result, msgId, chatId);

                } catch (err) {
                    console.error("❌ Error processing buy token state:", err);
                }
                break;


            case action.startsWith('sell-token-amount-') ? action : '':
                const sellAmountParts = action.split('-');
                const sellAmountStr = sellAmountParts.length > 3 ? sellAmountParts.slice(3).join('-') : '';

                try {
                    const userInfo = await helper.findUser(chatId, username);
                    if (!userInfo) {
                        console.error(`User info not found for chatId: ${chatId}, username: ${username}`);
                        return;
                    }

                    let sellAmount: number | null = null;

                    // Convert predefined text values to numbers
                    switch (sellAmountStr) {
                        case "15":
                        case "100":
                            sellAmount = parseFloat(sellAmountStr);
                            break;
                        case "x":
                            // Ask user to input a custom amount
                            await bot.sendMessage(chatId, "📝 Enter the amount you want to buy:");
                            helper.setUserState(chatId, "awaiting_custom_amount");
                            return;
                        default:
                            console.warn(`Invalid buy amount received: ${sellAmountStr}`);
                            return;
                    }

                    let currentAmount = userInfo.selectedSellToken[0]?.sellAmount || 0; // Default to 0 if not set

                    // If the amount is the same, return early
                    if (sellAmount === currentAmount) {
                        return;
                    }

                    // Update the database with the new amount
                    userInfo.selectedSellToken[0].sellAmount = sellAmount;
                    await helper.updateUserSelectedSellToken(chatId, { selectedSellToken: userInfo.selectedSellToken });

                    // Fetch updated wallet selection and send it as a message
                    result = await commands.selectedSellToken(chatId, username, userInfo.selectedSellToken[0].address);
                    await sendMessage(result, msgId, chatId);

                } catch (err) {
                    console.error("❌ Error processing buy amount:", err);
                }
                break;


            case 'buy-token-refresh':
                try {
                    // Retrieve user info from the database
                    const userInfo = await helper.findUser(chatId, username);
                    if (!userInfo) {
                        console.error(`User info not found for chatId: ${chatId}, username: ${username}`);
                        return;
                    }

                    // Get the address of the token to use for the refresh
                    const buyTokenAddress = userInfo.tokenAddress[0].address;

                    if (!buyTokenAddress) {
                        console.error("No token address found for the user.");
                        return;
                    }

                    // ✅ Completely reset tokenAddress in the database with an empty DocumentArray
                    await helper.updateUserTokenAddress(chatId, { tokenAddress: [] as unknown as Types.DocumentArray<any> });

                    // Proceed with the "buyToken" logic
                    result = await commands.buyToken(chatId, username, buyTokenAddress);

                    // Send the result message
                    await sendMessage(result, msgId, chatId);
                } catch (err) {
                    console.error("❌ Error processing buy amount:", err);
                }
                break;

            case 'sell-token-refresh':
                try {
                    // Retrieve user info from the database
                    const userInfo = await helper.findUser(chatId, username);
                    if (!userInfo) {
                        console.error(`User info not found for chatId: ${chatId}, username: ${username}`);
                        return;
                    }

                    // Get the address of the token to use for the refresh
                    const sellTokenData = userInfo.selectedSellToken[0];

                    if (!sellTokenData) {
                        console.error("No token address found for the user.");
                        return;
                    }

                    sellTokenData.sellAmount = 15;
                    sellTokenData.sellState = "Swap";

                    // ✅ Completely reset tokenAddress in the database with an empty DocumentArray
                    await helper.updateUserSelectedSellToken(chatId, { selectedSellToken: userInfo.selectedSellToken });

                    // Proceed with the "buyToken" logic
                    result = await commands.selectedSellToken(chatId, username, sellTokenData.address);

                    // Send the result message
                    await sendMessage(result, msgId, chatId);
                } catch (err) {
                    console.error("❌ Error processing buy amount:", err);
                }
                break;

            case 'confirm-buy-token':

                break;

            case 'toggle-sniping-mode':
                const keyboard = query.message?.reply_markup?.inline_keyboard || [];

                // Find the row with "Normal Mode" and "Pro Mode"
                const modeRowIndex = keyboard.findIndex(row =>
                    row.some(button => button.text.includes("Normal Mode") || button.text.includes("Pro Mode"))
                );

                // Find the row with the "Fee" button
                const feeRowIndex = keyboard.findIndex(row =>
                    row.some(button => button.text.includes("💰 Fee: 0SOL") || button.text.includes("💰 Max Fee: N/A SOL"))
                );

                if (modeRowIndex !== -1) {
                    // Get the existing buttons for Normal Mode and Pro Mode
                    let [normalButton, proButton] = keyboard[modeRowIndex];

                    // Only allow clicks when the button text is 🔴
                    if (normalButton.text === "🔴 Normal Mode" || proButton.text === "🔴 Pro Mode") {
                        if (normalButton.text === "🔴 Normal Mode") {
                            // Change Normal Mode to 🟢 and Pro Mode to 🔴
                            normalButton.text = "🟢 Normal Mode";
                            proButton.text = "🔴 Pro Mode";

                            // Set the Fee button to "💰 Fee: 0SOL"
                            if (feeRowIndex !== -1) {
                                const feeButton = keyboard[feeRowIndex].find(button => button.text.includes("💰 Max Fee: N/A SOL"));
                                if (feeButton) {
                                    feeButton.text = "💰 Fee: 0SOL";
                                }
                            }
                        } else if (proButton.text === "🔴 Pro Mode") {
                            // Change Pro Mode to 🟢 and Normal Mode to 🔴
                            proButton.text = "🟢 Pro Mode";
                            normalButton.text = "🔴 Normal Mode";

                            // Set the Fee button to "💰 N/M MAX"
                            if (feeRowIndex !== -1) {
                                const feeButton = keyboard[feeRowIndex].find(button => button.text.includes("💰 Fee: 0SOL"));
                                if (feeButton) {
                                    feeButton.text = "💰 Max Fee: N/A SOL";
                                }
                            }
                        }
                    }
                }

                // Update the message with the modified buttons
                await bot.editMessageReplyMarkup(
                    {
                        inline_keyboard: keyboard,
                    },
                    {
                        chat_id: chatId,
                        message_id: msgId, // Corrected extraction of message_id
                    }
                );
                break;

            case 'delete-sniper-token':
                const updatedTokens = await helper.deleteSnipingToken(chatId);

                if (updatedTokens !== false) {
                    // Call sniping to refresh UI
                    const result = await commands.lpDashboard(chatId, username);
                    await sendMessage(result, msgId, chatId);
                } else {
                    await bot.sendMessage(chatId, "❌ No token found to delete.");
                }
                break;

            case 'sniping-status':
                await bot.sendMessage(chatId, 'Sniper Status')

                // result = await commands.sniperStatus(chatId, username)
                // await sendMessage(result, msgId, chatId)
                break;

            case 'sniping-start-stop':
                await bot.sendMessage(chatId, 'Sniper is running now')

                result = await commands.startSniper(chatId, username)
                await sendMessage(result, msgId, chatId)
                break;

            case 'copytrade':
                result = await commands.copyTradeDashboard(chatId, username)
                await sendMessage(result, msgId, chatId)
                break;

            case 'copy-set-target':
                const sendCopyTargetAddrMsg = await bot.sendMessage(
                    chatId, '💼 Please send a token address to copy'
                )

                bot.once(`message`, async (msg) => {
                    if (msg.text) {
                        // result = await commands.addTargetWallet(chatId, username, msg.text)
                        // await sendMessage(result, msgId, chatId, true)
                        await bot.deleteMessage(chatId, sendCopyTargetAddrMsg.message_id)
                    }
                })
                break;

            case 'limitOrders':
                result = await commands.limitOrderDashboard(chatId, username)
                await sendMessage(result, msgId, chatId)
                break;

            case 'positions':
                result = await commands.positionsDashboard(chatId, username)
                await sendMessage(result, msgId, chatId)
                break;

            case 'withdraw':
                result = await commands.withdrawDashboard(chatId, username)
                await sendMessage(result, msgId, chatId)
                break;

            case 'referral':
                result = await commands.referralDashboard(chatId, username)
                await sendMessage(result, msgId, chatId)
                break;

            case 'manage-wallet':
                result = await commands.manageWallet(chatId, solanaConnection)
                await sendMessage(result, msgId, chatId)
                break;

            case 'import-wallet-confirm':
                result = await commands.importWalletConfirm(chatId)
                sendMessage(result, msgId, chatId)
                break;

            case 'import-wallet':
                const walletKeyMsg = await bot.sendMessage(chatId, 'Please send secret key of wallet to import.')

                bot.once(`message`, async (msg) => {
                    if (msg.text) {
                        result = await commands.importWallet(chatId, solanaConnection, msg.text)
                        await sleep(1000)
                        await bot.deleteMessage(chatId, walletKeyMsg.message_id)
                        sendMessage(result, msgId, chatId)
                        return
                    } else {
                        result = await commands.manageWallet(chatId, solanaConnection)
                        sendMessage(result, msgId, chatId)
                        return
                    }
                })
                break;

            case 'create-new-wallet-confirm':
                result = await commands.createNewWalletConfirm(chatId)
                sendMessage(result, msgId, chatId)
                break;

            case 'create-new-wallet':
                result = await commands.createNewWallet(chatId)
                sendMessage(result, msgId, chatId)
                break;

            case 'view-secret-key':
                result = await commands.showSecretKey(chatId, username)
                sendMessage(result, msgId, chatId)
                break;

        }
    } catch (e) {
        console.log(chatId, ' => Error handling callback query: \n', e)
    }
})

// await bot.answerCallbackQuery(callbackQueryId, { text: 'Input Token address to buy' })

const sendMessage = async (result: BotMsgResult, msgId: number, chatId: number, needDelete: boolean = false) => {
    try {
        // Delete the previous message (if applicable)
        if (needDelete)
            await bot.deleteMessage(chatId, msgId);

        // Send the new message using `rateLimitedSendMessage`
        await rateLimitedSendMessage(chatId, result.title, {
            reply_markup: {
                inline_keyboard: result.content,
                force_reply: false, // Disable input field
            },
            parse_mode: "HTML", // Ensures the message is formatted as HTML
            disable_web_page_preview: true // Disable link previews
        });
    } catch (error) {
        console.log(chatId, " => Error happened while dealing with message: \n", error)
    }
}

export const rateLimitedSendMessage: (
    chatId: TelegramBot.ChatId,
    text: string,
    options?: TelegramBot.SendMessageOptions,
) => Promise<TelegramBot.Message> = bottleneck.wrap(
    async (chatId: TelegramBot.ChatId, text: string, options?: TelegramBot.SendMessageOptions): Promise<TelegramBot.Message> => {
        return bot.sendMessage(chatId, text, options);
    }
);

export const prepareButtons = (tokenList: SellToken[] | null) => {
    if (!tokenList) return [];  // If tokenList is null, return an empty array

    // Map over tokenList and return buttons
    return tokenList.map((token: SellToken) => ({
        text: token.name,  // Use name from SellToken
        callback_data: token.address,  // Use address for callback_data
    }));
};

bot.on('message', async (msg) => {
    const chatId = msg.chat.id!;
    const text = msg.text?.trim()!;
    const username = msg.chat.username!;

    const userState = await helper.getUserState(chatId);
    if (userState === "awaiting_custom_amount") {
        const customAmount = parseFloat(text);
        if (isNaN(customAmount) || customAmount <= 0) {
            await bot.sendMessage(chatId, "❌ Invalid amount. Please enter a valid number.");
            return;
        }

        try {
            const userInfo = await helper.findUser(chatId, username);
            if (!userInfo || !userInfo.tokenAddress[0]) return;

            userInfo.tokenAddress[0].solAmount = customAmount;
            await helper.updateUserTokenAddress(chatId, { tokenAddress: userInfo.tokenAddress });

            helper.setUserState(chatId, null);

            const result = await commands.buyToken(chatId, username, userInfo.tokenAddress[0].address);
            await sendMessage(result, msg.message_id, chatId);
        } catch (err) {
            console.error("❌ Error processing custom amount:", err);
        }
    }
});
