/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 platformplus
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType } from "@utils/types";
import { AuthenticationStore, Menu, showToast } from "@webpack/common";

const extras = {
    web: { label: "Browser", properties: { os: "Windows", browser: "Chrome", device: "" } },
    mobile: { label: "Mobile", properties: { os: "iOS", browser: "Discord iOS", device: "iPhone" } },
    console: { label: "Console", properties: { os: "Xbox", browser: "Discord Embedded", device: "Xbox" } },
    vr: { label: "VR", properties: { os: "Windows", browser: "Discord VR", device: "Discord VR" } },
} as const;

type ExtraId = keyof typeof extras;
type SessionLook = "online" | "idle" | "dnd";

const extraIds = Object.keys(extras) as ExtraId[];
const looks: { id: SessionLook; label: string; }[] = [
    { id: "online", label: "Online" },
    { id: "idle", label: "Idle" },
    { id: "dnd", label: "Do Not Disturb" },
];

const statusOptions = looks.map((look, index) => ({ label: look.label, value: look.id, default: index === 0 }));

const settings = definePluginSettings({
    web: { type: OptionType.BOOLEAN, description: "", default: false, onChange: () => sync() },
    webStatus: { type: OptionType.SELECT, description: "", options: statusOptions, onChange: () => push("web") },
    mobile: { type: OptionType.BOOLEAN, description: "", default: false, onChange: () => sync() },
    mobileStatus: { type: OptionType.SELECT, description: "", options: statusOptions, onChange: () => push("mobile") },
    console: { type: OptionType.BOOLEAN, description: "", default: false, onChange: () => sync() },
    consoleStatus: { type: OptionType.SELECT, description: "", options: statusOptions, onChange: () => push("console") },
    vr: { type: OptionType.BOOLEAN, description: "", default: false, onChange: () => sync() },
    vrStatus: { type: OptionType.SELECT, description: "", options: statusOptions, onChange: () => push("vr") },
});

const sessions = new Map<ExtraId, { socket: WebSocket; heartbeat?: number; tries: number; ready: boolean; }>();
const attempts = new Map<ExtraId, number>();
const pending: ExtraId[] = [];
let connecting: ExtraId | null = null;

function discordToken() {
    return (AuthenticationStore as typeof AuthenticationStore & { getToken(): string | null; }).getToken();
}

function gatewayUrl() {
    const base = (window as Window & { GLOBAL_ENV?: { GATEWAY?: string; }; }).GLOBAL_ENV?.GATEWAY || "wss://gateway.discord.gg";
    return `${base.replace(/\/$/, "")}/?v=10&encoding=json`;
}

function sessionLook(id: ExtraId): SessionLook {
    const value = settings.store[`${id}Status`];
    if (value === "idle" || value === "dnd") return value;
    return "online";
}

function presenceFor(id: ExtraId) {
    const look = sessionLook(id);
    return {
        status: look,
        since: look === "idle" ? Date.now() : null,
        afk: look === "idle",
        activities: [],
    };
}

function send(socket: WebSocket, op: number, data: unknown) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op, d: data }));
}

function push(id: ExtraId) {
    const session = sessions.get(id);
    if (session) send(session.socket, 3, presenceFor(id));
}

function settle(id: ExtraId) {
    if (connecting !== id) return;
    connecting = null;
    window.setTimeout(drain, 800);
}

function drain() {
    if (connecting) return;
    while (pending.length) {
        const id = pending.shift()!;
        if (!settings.store[id] || sessions.has(id)) continue;
        connecting = id;
        connect(id);
        return;
    }
}

function identify(id: ExtraId, socket: WebSocket) {
    const token = discordToken();
    if (!token || sessions.get(id)?.socket !== socket) return;
    send(socket, 2, {
        token,
        capabilities: 1734653,
        properties: extras[id].properties,
        presence: presenceFor(id),
        compress: false,
        client_state: { guild_versions: {} },
    });
}

function reject(id: ExtraId) {
    showToast({ text: `Discord rejected the ${extras[id].label} session`, variant: "critical" });
    settings.store[id] = false;
}

function disconnect(id: ExtraId) {
    const queued = pending.indexOf(id);
    if (queued !== -1) pending.splice(queued, 1);
    const session = sessions.get(id);
    if (!session) {
        settle(id);
        return;
    }
    sessions.delete(id);
    if (session.heartbeat) clearInterval(session.heartbeat);
    session.socket.onclose = null;
    session.socket.onmessage = null;
    session.socket.close();
    settle(id);
}

function connect(id: ExtraId) {
    if (sessions.has(id)) {
        settle(id);
        return;
    }
    const token = discordToken();
    if (!token) {
        showToast({ text: "Couldn't read this Discord login.", variant: "critical" });
        settings.store[id] = false;
        return;
    }

    const socket = new WebSocket(gatewayUrl());
    const session = { socket, heartbeat: undefined as number | undefined, tries: 0, ready: false };
    attempts.set(id, (attempts.get(id) ?? 0) + 1);
    sessions.set(id, session);
    let seq: number | null = null;

    socket.onmessage = event => {
        if (sessions.get(id)?.socket !== socket || typeof event.data !== "string") return;
        let packet: { op: number; d?: any; s?: number | null; t?: string | null; };
        try {
            packet = JSON.parse(event.data);
        } catch {
            return;
        }
        if (packet.s != null) seq = packet.s;

        if (packet.op === 10) {
            const interval = packet.d?.heartbeat_interval ?? 41250;
            session.heartbeat = window.setInterval(() => send(socket, 1, seq), interval);
            session.tries++;
            identify(id, socket);
            return;
        }

        if (packet.op === 1) {
            send(socket, 1, seq);
            return;
        }

        if (packet.op === 0 && packet.t === "READY") {
            session.ready = true;
            attempts.delete(id);
            showToast({ text: `${extras[id].label} is showing next to desktop` });
            settle(id);
            return;
        }

        if (packet.op === 9) {
            if (session.tries >= 3) {
                reject(id);
                return;
            }
            const wait = session.tries === 1 ? 1000 : 2500;
            session.tries++;
            window.setTimeout(() => identify(id, socket), wait);
        }
    };

    socket.onclose = event => {
        if (session.heartbeat) clearInterval(session.heartbeat);
        if (sessions.get(id)?.socket !== socket) return;
        sessions.delete(id);
        if (!session.ready && settings.store[id] && event.code !== 1000 && (attempts.get(id) ?? 0) < 3) {
            pending.unshift(id);
            settle(id);
            return;
        }
        if (event.code === 4004) reject(id);
        else settle(id);
    };
}

function sync() {
    for (const id of extraIds) {
        if (!settings.store[id]) {
            attempts.delete(id);
            disconnect(id);
            continue;
        }
        if (!sessions.has(id) && connecting !== id && !pending.includes(id)) pending.push(id);
    }
    drain();
}

function summary() {
    const names = ["Desktop"];
    for (const id of extraIds) {
        if (!settings.store[id]) continue;
        const look = looks.find(item => item.id === sessionLook(id))?.label ?? "Online";
        names.push(`${extras[id].label} ${look}`);
    }
    return names.join(", ");
}

function RowIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M4 4h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-6v2h3v2H7v-2h3v-2H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
        </svg>
    );
}

function PlatformRow({ Row }: { Row: any; }) {
    const chosen = settings.use(["web", "webStatus", "mobile", "mobileStatus", "console", "consoleStatus", "vr", "vrStatus"]);

    return (
        <Row
            label="Platform"
            sublabel={summary()}
            icon={RowIcon}
            renderSubmenu={({ closePopout }: { closePopout(): void; }) => (
                <Menu.Menu navId="vc-platform" onClose={closePopout} aria-label="Platform">
                    {extraIds.map(id => (
                        <Menu.MenuItem key={id} id={`vc-platform-${id}`} label={extras[id].label}>
                            <Menu.MenuCheckboxItem
                                id={`vc-platform-${id}-show`}
                                label="Show"
                                checked={Boolean(chosen[id])}
                                action={() => settings.store[id] = !chosen[id]}
                            />
                            {looks.map(look => (
                                <Menu.MenuRadioItem
                                    key={look.id}
                                    group={`vc-platform-${id}-status`}
                                    id={`vc-platform-${id}-${look.id}`}
                                    label={look.label}
                                    checked={sessionLook(id) === look.id}
                                    action={() => settings.store[`${id}Status`] = look.id}
                                />
                            ))}
                        </Menu.MenuItem>
                    ))}
                </Menu.Menu>
            )}
        />
    );
}

export default definePlugin({
    name: "platformplus",
    description: "extra platform sessions over their own websocket, you can spoof yourself as any of the 4 extra platforms with seperate activity status per platform. doesnt / cant override the desktop session.",
    authors: [{ name: "dealuh", id: 1017587396239442011n }],
    enabledByDefault: true,
    settings,

    start() {
        sync();
    },

    stop() {
        pending.length = 0;
        for (const id of extraIds) disconnect(id);
        connecting = null;
    },

    patches: [
        {
            find: 'action:"PRESS_SET_STATUS"',
            replacement: {
                match: /\(0,(\i)\.jsx\)\((\i),\{action:"PRESS_SET_STATUS".{0,1400}?onClick:\i\.\i\?\(\)=>\{(\i)\(\).{0,500}?:void 0\}\),(?=\i&&\(0,\1\.jsx\)\(\2,\{action:"PRESS_VIEW_BADGES")/,
                replace: "$&$self.PlatformRow({Row:$2}),"
            }
        }
    ],

    PlatformRow: ErrorBoundary.wrap(PlatformRow, { noop: true }),
});
