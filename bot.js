const { Client, GatewayIntentBits, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const GIFEncoder = require('gifencoder');
const { createCanvas } = require('canvas');
const puppeteer = require('puppeteer');
const { PNG } = require('pngjs');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// In-memory guild member cache to avoid repeated API calls
const memberCache = new Map(); // guildId -> { ts: number }

/**
 * Ensure guild members are fetched and cached for a short TTL.
 * Returns the guild.members.cache Collection.
 */
async function fetchMembersIfNeeded(guild, ttl = 60_000) {
    const cached = memberCache.get(guild.id);
    if (!cached || (Date.now() - cached.ts) > ttl) {
        // Fetch all members from Discord (one API call) and update timestamp
        await guild.members.fetch();
        memberCache.set(guild.id, { ts: Date.now() });
    }
    return guild.members.cache;
}

/**
 * Async: get users with a role using a cached fetch of guild members.
 */
async function getUsersWithRoleCached(guild, roleName) {
    const role = getRole(guild, roleName);
    if (!role) return [];
    const members = await fetchMembersIfNeeded(guild);
    return members.filter(member => member.roles.cache.has(role.id)).map(member => member);
}

/**
 * Show a cancel button under the given message and wait up to `timeout` ms.
 * Resolves `true` if the initiator pressed Cancel, `false` otherwise.
 */
function waitForCancelButton(spinMessage, initiator, timeout = 7000) {
    return new Promise(async (resolve) => {
        if (!spinMessage) return resolve(false);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('spin_cancel')
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Danger)
        );

        try {
            await spinMessage.edit({ components: [row] });
        } catch (e) {
            // ignore edit errors
        }

        let resolved = false;
        const collector = spinMessage.createMessageComponentCollector({ componentType: ComponentType.Button, time: timeout });

        collector.on('collect', async (interaction) => {
            if (interaction.customId !== 'spin_cancel') return;
            if (interaction.user.id !== initiator.id) {
                try { await interaction.reply({ content: 'Only the command issuer can cancel this spin.', ephemeral: true }); } catch (e) {}
                return;
            }
            resolved = true;
            try { await interaction.update({ content: '🛑 Spin cancelled', components: [] }); } catch (e) {}
            collector.stop('cancelled');
            resolve(true);
        });

        collector.on('end', async (_collected, reason) => {
            if (!resolved) {
                // timeout or other end
                try { await spinMessage.edit({ components: [] }); } catch (e) {}
                resolve(false);
            }
        });
    });
}

// Bot setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// Role names
const ON_THE_WHEEL = "On the wheel";
const OFF_THE_WHEEL = "Off the wheel";
const YOUR_WEEK = "Pig of the week";

// Colors for the wheel (cycling through these)
const WHEEL_COLORS = [
    [255, 100, 100],  // Red
    [100, 255, 100],  // Green
    [100, 100, 255],  // Blue
    [255, 255, 100],  // Yellow
    [255, 100, 255],  // Magenta
    [100, 255, 255],  // Cyan
    [255, 200, 100],  // Orange
    [200, 100, 255],  // Purple
];

// Pointer angle (radians). 0 == 0° (points to the right).
const POINTER_ANGLE = 0;
// Fixed number of rotations before landing (deterministic)
const FIXED_ROTATIONS = 4;

/**
 * Create a visual representation of the wheel with names
 */
function createWheelImage(names, winnerIndex = null, size = 800, rotation = 0) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    const centerX = size / 2;
    const centerY = size / 2;
    const radius = size / 2 - 20;

    // Clear background
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, size, size);

    if (!names || names.length === 0) {
        ctx.fillStyle = 'black';
        ctx.font = '30px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('No names', centerX, centerY);
        return canvas;
    }

    const numSegments = names.length;
    const anglePerSegment = (2 * Math.PI) / numSegments;

    // Apply rotation around center
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(rotation);

    // Draw wheel segments centered at (0,0)
    for (let i = 0; i < names.length; i++) {
        const startAngle = i * anglePerSegment - Math.PI / 2;
        const endAngle = (i + 1) * anglePerSegment - Math.PI / 2;

        let color = WHEEL_COLORS[i % WHEEL_COLORS.length];
        if (winnerIndex !== null && i === winnerIndex) {
            color = color.map(c => Math.min(255, c + 50));
        }

        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, radius, startAngle, endAngle);
        ctx.closePath();
        ctx.fillStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
        ctx.fill();
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Draw name text
        const midAngle = (startAngle + endAngle) / 2;
        const textRadius = radius * 0.7;
        const textX = textRadius * Math.cos(midAngle);
        const textY = textRadius * Math.sin(midAngle);
        const displayName = names[i];

        ctx.save();
        ctx.translate(textX, textY);
            // Rotate labels so they read along the radius (long-ways).
            // Flip by PI for segments on the left side so text remains upright.
            let textRotation = midAngle + Math.PI / 2;
            if (Math.cos(midAngle) < 0) textRotation += Math.PI;
            ctx.rotate(textRotation);

        // Fit text: try to reduce font size to fit the available arc width.
        let fontSize = 20;
        ctx.fillStyle = 'black';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `bold ${fontSize}px Arial`;

        // approximate available width on the arc for this segment
        const maxWidth = Math.max(40, anglePerSegment * textRadius * 0.9);
        while (fontSize > 8 && ctx.measureText(displayName).width > maxWidth) {
            fontSize--;
            ctx.font = `bold ${fontSize}px Arial`;
        }

        const chars = displayName.split('');
            const charSpacing = fontSize - 6;
            const totalW = chars.length * charSpacing;
            let startX = -totalW / 2 + charSpacing / 2;

            ctx.save();
            // rotate so characters appear upright horizontally on-screen
            ctx.rotate(-Math.PI / 2);
            for (let k = 0; k < chars.length; k++) {
                ctx.fillText(chars[k], startX + k * charSpacing, 0);
            }
            ctx.restore();

        ctx.restore();
    }

    // Center circle
    ctx.beginPath();
    ctx.arc(0, 0, 30, 0, 2 * Math.PI);
    ctx.fillStyle = 'white';
    ctx.fill();
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.restore();

    // Draw fixed pointer at the configured angle (not rotated with the wheel)
    (function drawPointer() {
        const angle = POINTER_ANGLE; // absolute angle where pointer points
        // Flip pointer so the tip points toward the wheel center (inward)
        const tipDist = radius - 10; // tip sits slightly inside wheel
        const baseDist = radius + 18; // base of triangle sits outside wheel
        const sideOffset = 24; // how wide the pointer base is

        const tipX = centerX + tipDist * Math.cos(angle);
        const tipY = centerY + tipDist * Math.sin(angle);

        const baseCenterX = centerX + baseDist * Math.cos(angle);
        const baseCenterY = centerY + baseDist * Math.sin(angle);

        const leftX = baseCenterX + sideOffset * Math.cos(angle + Math.PI / 2);
        const leftY = baseCenterY + sideOffset * Math.sin(angle + Math.PI / 2);

        const rightX = baseCenterX + sideOffset * Math.cos(angle - Math.PI / 2);
        const rightY = baseCenterY + sideOffset * Math.sin(angle - Math.PI / 2);

        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(leftX, leftY);
        ctx.lineTo(rightX, rightY);
        ctx.closePath();
        ctx.fillStyle = 'red';
        ctx.fill();
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 2;
        ctx.stroke();
    })();

    return canvas;
}

// Node-side sleep used for polling (avoids calling Puppeteer page.waitForTimeout)
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// (no-op) helper removed — using Puppeteer's built-in timing

/**
 * Create an animated GIF that spins and stops on the winner
 */
async function createSpinningAnimation(names, winnerIndex, channel) {
    if (!names || names.length === 0) return null;
    const size = 800;

    const totalRotations = FIXED_ROTATIONS; // deterministic spins
    const totalFrames = 60;
    const slowDownFrames = 20;

    const anglePerSegment = (2 * Math.PI) / names.length;
    // mid-angle of the winner segment (at rotation=0)
    const winnerMidAngle = ((winnerIndex + 0.5) * anglePerSegment) - (Math.PI / 2);
    // We want the winner to land at POINTER_ANGLE. Add fixed whole rotations before landing.
    const finalRotationRad = (totalRotations * 2 * Math.PI) + (POINTER_ANGLE - winnerMidAngle);

    const encoder = new GIFEncoder(size, size);
    const buffers = [];
    const stream = encoder.createReadStream();
    stream.on('data', (chunk) => buffers.push(chunk));

    encoder.start();
    encoder.setRepeat(0);
    encoder.setQuality(10);

    function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

    for (let frame = 0; frame < totalFrames; frame++) {
        let progress = frame / (totalFrames - 1);
        const eased = easeOutCubic(progress);
        const angle = eased * finalRotationRad;

        // draw wheel rotated by `angle`
        const canvas = createWheelImage(names, null, size, angle);
        const ctx = canvas.getContext('2d');

        // On last frames highlight the winner (draw again with highlight)
        if (frame >= totalFrames - 5) {
            const highlightCanvas = createWheelImage(names, winnerIndex, size, angle);
            encoder.setDelay(frame < totalFrames - slowDownFrames ? 30 : 50 + (frame - (totalFrames - slowDownFrames)) * 15);
            encoder.addFrame(highlightCanvas.getContext('2d'));
        } else {
            encoder.setDelay(frame < totalFrames - slowDownFrames ? 30 : 50 + (frame - (totalFrames - slowDownFrames)) * 15);
            encoder.addFrame(ctx);
        }
    }

    encoder.finish();
    await new Promise((resolve) => stream.on('end', resolve));

    const gifBuffer = Buffer.concat(buffers);
    const attachment = new AttachmentBuilder(gifBuffer, { name: 'wheel_spin.gif' });
    const spinMessage = await channel.send({ files: [attachment] });
    return spinMessage;
}

/**
 * Create an animation by rendering an HTML/CSS animated wheel in headless Chromium.
 * The provided winnerIndex will be placed at index 0 in the randomized list so
 * the wheel can always land at the same pointer position while the ordering
 * of names changes between spins.
 */
async function createCssSpinAnimation(names, winnerIndex, channel) {
        // Simplified: use the server-side canvas GIF generator instead of Puppeteer.
        // This is reliable and easier to maintain.
            return await createSpinningAnimation(names, 0, channel);
}

/**
 * Get a role by name, case-insensitive
 */
function getRole(guild, roleName) {
    return guild.roles.cache.find(role => 
        role.name.toLowerCase() === roleName.toLowerCase()
    );
}

/**
 * Get all users with a specific role
 */
function getUsersWithRole(guild, roleName) {
    const role = getRole(guild, roleName);
    if (!role) {
        return [];
    }

    return guild.members.cache.filter(member => 
        member.roles.cache.has(role.id)
    ).map(member => member);
}

/**
 * Update a user's roles
 */
async function updateUserRoles(member, addRoles, removeRoles) {
    try {
        if (addRoles && addRoles.length > 0) {
            await member.roles.add(addRoles, 'Wheel spin result');
        }
        if (removeRoles && removeRoles.length > 0) {
            await member.roles.remove(removeRoles, 'Wheel spin result');
        }
        return true;
    } catch (error) {
        console.error(`Error updating roles: ${error.message}`);
        return false;
    }
}

/**
 * Spin the wheel and return a random winner
 */
function spinWheel(users) {
    if (!users || users.length === 0) {
        return null;
    }
    // return a random index (caller can get the item by index)
    return Math.floor(Math.random() * users.length);
}

// Shuffle helper
function shuffleArray(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// Return a new array where the chosen winnerIndex is placed at index 0,
// and the remaining items are shuffled (so animation can always land on index 0).
function orderedForWinner(names, winnerIndex) {
    if (!Array.isArray(names) || names.length === 0) return [];
    const winner = names[winnerIndex];
    const others = names.slice();
    others.splice(winnerIndex, 1);
    const shuffled = shuffleArray(others);
    return [winner, ...shuffled];
}

// Bot events
function handleReady() {
    console.log('═══════════════════════════════════════');
    console.log('🎡 SPINNY IS ONLINE! 🎡');
    console.log(`Logged in as: ${client.user.tag}`);
    console.log(`Bot ID: ${client.user.id}`);
    console.log(`Ready to spin wheels! Use !spin or !test`);
    console.log('═══════════════════════════════════════');
}

// Listen for both names to silence deprecation and remain compatible across versions
client.once('ready', handleReady);
client.once('clientReady', handleReady);

client.on('messageCreate', async (message) => {
    // Ignore messages from bots
    if (message.author.bot) return;

    // Check for !test command (uses fake data)
    if (message.content === '!test') {
        await message.channel.send("🎡 Starting the wheel spinning process with TEST DATA...");

        // Test data
        const testNamesOffWheel = [
            "Alice", "Bob", "Charlie", "Diana", "Eve", "Frank", "Grace", "Henry"
        ];

        const testNamesOnWheel = [
            "Iris", "Jack", "Kate", "Liam", "Mia", "Noah", "Olivia", "Paul", "Quinn", "Ryan"
        ];

        const messagesToCleanup = [];

        // Step 1: Check if we need to spin for "Off the wheel" users
        if (testNamesOffWheel.length >= 6) {
            const infoMsg = await message.channel.send(
                `🔄 Found ${testNamesOffWheel.length} users 'Off the wheel'. Spinning to bring one back...`
            );
            messagesToCleanup.push(infoMsg);

            const winnerIndex = spinWheel(testNamesOffWheel);
            const winner = testNamesOffWheel[winnerIndex];

            // Reorder names so the chosen winner will be at index 0 during animation
            const orderedTestOff = orderedForWinner(testNamesOffWheel, winnerIndex);

            // Create animation (show status while generating)
            const statusMsg = await message.channel.send('🔄 Getting ready to spin, please wait...');
            messagesToCleanup.push(statusMsg);
            const spinMsg = await createCssSpinAnimation(orderedTestOff, 0, message.channel);
            if (spinMsg) {
                const cancelled = await waitForCancelButton(spinMsg, message.author, 7000);
                try { await spinMsg.delete(); } catch (e) { /* ignore */ }
                if (cancelled) {
                    await message.channel.send('🛑 Spin cancelled.');
                    return;
                }
            }

            await message.channel.send(`🎉 **${winner}** is back on the wheel! (TEST MODE - no roles updated)`);
        } else {
            await message.channel.send(
                `ℹ️ Only ${testNamesOffWheel.length} users 'Off the wheel' (need 6+ to spin). Skipping this step.`
            );
        }

        // Step 2: Spin for "On the wheel" users until one remains
        if (testNamesOnWheel.length < 2) {
            await message.channel.send(
                `❌ Need at least 2 users with 'On the wheel' role to spin. Currently: ${testNamesOnWheel.length}`
            );
            return;
        }

        const startMsg = await message.channel.send(
            `🎡 Spinning the wheel for ${testNamesOnWheel.length} users 'On the wheel'...`
        );
        messagesToCleanup.push(startMsg);

        const remainingNames = [...testNamesOnWheel];
        let roundNum = 1;

        while (remainingNames.length > 1) {
            const winnerIndex = spinWheel(remainingNames);
            const winner = remainingNames[winnerIndex];

            const roundMsg = await message.channel.send(`🔄 Round ${roundNum}: Spinning...`);
            messagesToCleanup.push(roundMsg);

            // Create and send animation (show status while generating)
            const statusMsg = await message.channel.send('🔄 Getting ready to spin, please wait...');
            messagesToCleanup.push(statusMsg);
            const orderedNames = orderedForWinner(remainingNames, winnerIndex);
            const spinMsg = await createCssSpinAnimation(orderedNames, 0, message.channel);
            if (spinMsg) {
                const cancelled = await waitForCancelButton(spinMsg, message.author, 7000);
                try { await spinMsg.delete(); } catch (e) { /* ignore */ }
                if (cancelled) {
                    await message.channel.send('🛑 Spin cancelled.');
                    return;
                }
            }

            await message.channel.send(`🎯 **${winner}** has been removed from the wheel!`);

            // Remove winner from remaining names (original array)
            remainingNames.splice(winnerIndex, 1);
            roundNum++;

            // Small delay for better UX
            await sleep(500);
        }

        // Final winner
        if (remainingNames.length === 1) {
            const finalWinner = remainingNames[0];
            await message.channel.send(
                `🏆 **FINAL WINNER: ${finalWinner}** is this week's winner! (TEST MODE - no roles updated)`
            );
        } else {
            await message.channel.send("❌ Error: No final winner determined!");
        }

        // Clean up intermediate messages after a short delay
        setTimeout(async () => {
            for (const msg of messagesToCleanup) {
                try {
                    await msg.delete();
                } catch (err) {
                    // Ignore errors (message might already be deleted)
                }
            }
        }, 3000);
        return;
    }

    // Check for !spin command
    if (message.content === '!spin') {
        if (!message.guild) {
            await message.channel.send("This command can only be used in a server!");
            return;
        }

        // Check if bot has necessary permissions
        if (!message.guild.members.me.permissions.has('ManageRoles')) {
            await message.channel.send("❌ I need the 'Manage Roles' permission to work!");
            return;
        }

        await message.channel.send("🎡 Starting the wheel spinning process...");

        const messagesToCleanup = [];

        // Step 1: Check if we need to spin for "Off the wheel" users
        const offWheelUsers = await getUsersWithRoleCached(message.guild, OFF_THE_WHEEL);

        if (offWheelUsers.length >= 6) {
            const infoMsg = await message.channel.send(
                `🔄 Found ${offWheelUsers.length} users 'Off the wheel'. Spinning to bring one back...`
            );
            messagesToCleanup.push(infoMsg);

                const offWheelNames = offWheelUsers.map(user => user.displayName);
                const winnerIndex = spinWheel(offWheelUsers);

                if (winnerIndex !== null && winnerIndex !== undefined) {
                    const winner = offWheelUsers[winnerIndex];
                    // Create animation (show status while generating)
                    const statusMsg = await message.channel.send('🔄 Getting ready to spin, please wait...');
                    messagesToCleanup.push(statusMsg);
                    // Reorder names so the chosen winner is at index 0, then animate landing at pointer
                    const ordered = orderedForWinner(offWheelNames, winnerIndex);
                    const spinMsg = await createCssSpinAnimation(ordered, 0, message.channel);
                    if (spinMsg) {
                        const cancelled = await waitForCancelButton(spinMsg, message.author, 7000);
                        try { await spinMsg.delete(); } catch (e) { /* ignore */ }
                        if (cancelled) {
                            await message.channel.send('🛑 Spin cancelled.');
                            return;
                        }
                    }

                    await message.channel.send(`🎉 **${winner.displayName}** is back on the wheel!`);

                // Update roles
                const onRole = getRole(message.guild, ON_THE_WHEEL);
                const offRole = getRole(message.guild, OFF_THE_WHEEL);

                if (onRole && offRole) {
                    const success = await updateUserRoles(winner, [onRole], [offRole]);
                    if (success) {
                        await message.channel.send(`✅ Updated roles for ${winner.displayName}`);
                    } else {
                        await message.channel.send(`⚠️ Could not update roles for ${winner.displayName}. Please check permissions.`);
                    }
                } else {
                    await message.channel.send("⚠️ Warning: Could not find required roles!");
                }
            }
        } else {
            await message.channel.send(
                `ℹ️ Only ${offWheelUsers.length} users 'Off the wheel' (need 6+ to spin). Skipping this step.`
            );
        }

        // Step 2: Spin for "On the wheel" users until one remains
        let onWheelUsers = await getUsersWithRoleCached(message.guild, ON_THE_WHEEL);

        if (onWheelUsers.length < 2) {
            await message.channel.send(
                `❌ Need at least 2 users with 'On the wheel' role to spin. Currently: ${onWheelUsers.length}`
            );
            return;
        }

        const startMsg = await message.channel.send(
            `🎡 Spinning the wheel for ${onWheelUsers.length} users 'On the wheel'...`
        );
        messagesToCleanup.push(startMsg);

        const remainingUsers = [...onWheelUsers];
        let roundNum = 1;

        while (remainingUsers.length > 1) {
            const names = remainingUsers.map(user => user.displayName);
            const winnerIndex = spinWheel(remainingUsers);

            if (winnerIndex === null || winnerIndex === undefined) {
                break;
            }

            const winner = remainingUsers[winnerIndex];
            const roundMsg = await message.channel.send(`🔄 Round ${roundNum}: Spinning...`);
            messagesToCleanup.push(roundMsg);

            // Create and send animation (show status while generating)
            const statusMsg = await message.channel.send('🔄 Getting ready to spin, please wait...');
            messagesToCleanup.push(statusMsg);
            const ordered = orderedForWinner(names, winnerIndex);
            const spinMsg = await createCssSpinAnimation(ordered, 0, message.channel);
            if (spinMsg) {
                const cancelled = await waitForCancelButton(spinMsg, message.author, 7000);
                try { await spinMsg.delete(); } catch (e) { /* ignore */ }
                if (cancelled) {
                    await message.channel.send('🛑 Spin cancelled.');
                    return;
                }
            }

            await message.channel.send(`🎯 **${winner.displayName}** has been removed from the wheel!`);

            // Remove winner from remaining users
            remainingUsers.splice(winnerIndex, 1);
            roundNum++;

            // Small delay for better UX
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Clean up intermediate messages after a short delay
        setTimeout(async () => {
            for (const msg of messagesToCleanup) {
                try {
                    await msg.delete();
                } catch (err) {
                    // Ignore errors (message might already be deleted)
                }
            }
        }, 3000);

        // Final winner
        if (remainingUsers.length === 1) {
            const finalWinner = remainingUsers[0];
            await message.channel.send(
                `🏆 **FINAL WINNER: ${finalWinner}** is Pig of the week!`
            );

            // Update final winner's roles
            const onRole = getRole(message.guild, ON_THE_WHEEL);
            const offRole = getRole(message.guild, OFF_THE_WHEEL);
            const weekRole = getRole(message.guild, YOUR_WEEK);

            // Ensure only one user has the 'Your week' role: remove it from any current holders
            if (weekRole) {
                const currentHolders = await getUsersWithRoleCached(message.guild, YOUR_WEEK);
                for (const holder of currentHolders) {
                    if (holder.id !== finalWinner.id) {
                        try {
                            await updateUserRoles(holder, [], [weekRole]);
                        } catch (err) {
                            console.error(`Failed to remove ${YOUR_WEEK} from ${holder.displayName}: ${err.message}`);
                        }
                    }
                }
            }

            const rolesToAdd = [];
            const rolesToRemove = [];
             const weeklyPhrases = [
                "Don't waste the cosmic favour, pig.",
                "You better not fuck us!",
                "May your RNG be kind and your drops be clean, piggy.",
                "May your pitch drop be legendary and your mesos never vanish.",
                "Poggers! May your boss drops crit every time.",
                "Oink oink — may your rolls be blessed.",
                "May your star force be gold, and your comms not be mold.",
                "Don't gimp the party, oinker.",
                "May your cubes hit god-tier potential.",
                "May your drop table pity you this week.",
                "Keep chugging pots and critting bosses, pig.",
                "May your mesos stack and your lag be small.",
                "May your epic drop be non-shitter and very pog.",
                "You got the piggy touch — don't blow it, legend.",
                "May your stars align and your flame not fizzle.",
                "May gachas be merciful and your RNG not betray you.",
                "Oink if you score a pitch drop before breakfast.",
                "May your runs be clean and your drop not mean.",
                "May your drop rates be blessed by the RNG gods.",
                "Feed the pig right — it returns you epic loot.",
                "May your cubes bless you with Godly lines, piggy.",
                "Less mold, more pog — good drops incoming.",
                "May your scrolling be safe and your flames peak.",
                "Gamblers never quit, and quitters never win.",
                "Pigs — may your star force upgrades never fail.",
                "You lucky oinker.",
                "This week: big pig energy, bigger drops, no shitter RNG.",
                "Luck is a pig — fatten it with patience, don't let it hog your reason.",
                "Gamble like a pig: snuffle for opportunity, celebrate the tasty drops.",
                "RNG is just the universe's mood swing; feed it treats and it might smile.",
                "A pitch drop is a prayer answered by statistics and a little pork luck.",
                "Mesos come and go; the true fortune is not losing your hog soul to rage.",
                "Feed the pig of chance with runs and potions; it returns in blessed drops.",
                "Star force is faith measured in scrolls — upgrade your courage, not your anger.",
                "The gambler's zen: accept the shitter drops, cherish the pog ones.",
                "Pigs don't worry about misses — they root for the next big crit.",
                "Cubes are tiny boxes of destiny; open them with reverence and snacks.",
                "Luck prefers the persistent pig over the panicked hoarder.",
                "A true pig knows: RNG is theater — play your part and enjoy the applause.",
                "Blessed is the pig who grinds in silence and gets pitch drops loudly.",
                "You can't bribe probability, but you can cultivate rituals that feel lucky.",
                "May your mesos flow like a river and your inventories never choke.",
                "The wise pig treats every failure as practice for the next pog moment.",
                "In the casino of life, pigs wager hope and harvest stories.",
                "Don't curse the RNG; teach it to love you with sacrifice and memes.",
                "A lucky pig is humble — it knows tomorrow the table will tilt again.",
                "Pog is a state of mind; drops are merely the currency of validation.",
                "Oink at fate, then grind harder — sometimes noise is the ritual it respects.",
                "Gambling teaches patience; pigs learn to wait between snacks and jackpots.",
                "Fortune is flattered by persistence and occasionally bribed with effort.",
                "The pig who chases every drop ends up hungry; the patient pig eats well.",
                "If life deals you shitter RNG, season it with humor and call it a weird flex."
            ];
            const randomPhrase = weeklyPhrases[Math.floor(Math.random() * weeklyPhrases.length)];

            if (weekRole) rolesToAdd.push(weekRole);
            if (offRole) rolesToAdd.push(offRole);
            if (onRole) rolesToRemove.push(onRole);

            if (rolesToAdd.length > 0 || rolesToRemove.length > 0) {
                const success = await updateUserRoles(finalWinner, rolesToAdd, rolesToRemove);
                if (success) {
                    await message.channel.send(
                        `${randomPhrase}`
                    );
                } else {
                    await message.channel.send(
                        `⚠️ Could not update roles for ${finalWinner.displayName}. Please check permissions.`
                    );
                }
            } else {
                await message.channel.send("⚠️ Warning: Could not find required roles!");
            }
        } else {
            await message.channel.send("❌ Error: No final winner determined!");
        }
    }
});

// Error handling
client.on('error', error => {
    console.error('Discord client error:', error);
});

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

// Start the bot
const token = process.env.DISCORD_TOKEN;
if (!token) {
    console.error('Error: DISCORD_TOKEN not found in environment variables!');
    console.error('Please create a .env file with your Discord bot token.');
    process.exit(1);
}

client.login(token);


