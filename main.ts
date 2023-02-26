import dotenv from "dotenv";
dotenv.config();
import socketio, { Socket } from "socket.io";
import express from "express";
import cors from "cors";

import debug from "debug";
import { randomBytes } from "crypto";
import { createServer } from "http";

import {
  KvsMemoryStorage,
  kvsMemoryStorage,
  KvsMemoryStorageSchema,
} from "@kvs/memorystorage";

const log = debug("http");

interface ISession {
  timestamp: number;
  xTokenId: string;
  xContractAddr: string;
  xAddr: string;
  yTokenId: string;
  yContractAddr: string;
  yAddr: string;
  xApproved: boolean;
  yApproved: boolean;
}

async function attachHandlers(
  socket: Socket,
  sessionId: string,
  userAddress: string,
  storage: KvsMemoryStorage<KvsMemoryStorageSchema>,
  io: socketio.Server
) {
  const preSockets = await socket.in(sessionId).fetchSockets();
  preSockets
    .find((s) => s.handshake.headers["x-address"] === userAddress)
    ?.disconnect();

  socket.on("nft-selected", async (data) => {
    log("NFT selected", data);
    const d = (await storage.get(
      "session-" + sessionId
    )) as unknown as ISession;
    console.log(d);
    if (d) {
      if (d.xAddr === userAddress) {
        d.xContractAddr = data.contractAddress;
        d.xTokenId = data.tokenId;
        d.xApproved = false;
      } else {
        d.yContractAddr = data.contractAddress;
        d.yTokenId = data.tokenId;
        d.yApproved = false;
      }
      await storage.set("session-" + sessionId, {
        ...d,
      });
    }
    socket.to(sessionId).emit("target-nft-selected", {
      contractAddress: data.contractAddress,
      tokenId: data.tokenId,
    });
  });

  socket.on("swapped", (data: ISession) => {
    log("swapped");
    io.to(sessionId).emit("swapped", data);
  });
  socket.on("nft-approved", async (data) => {
    log("NFT approved", data);
    const d = (await storage.get(
      "session-" + sessionId
    )) as unknown as ISession;
    console.log(d);
    if (d) {
      if (d.xAddr === userAddress) {
        d.xContractAddr = data.contractAddress;
        d.xTokenId = data.tokenId;
        d.xApproved = true;
        if (d.yApproved) {
          socket.emit("process-swap", d);
        }
      } else {
        d.yContractAddr = data.contractAddress;
        d.yTokenId = data.tokenId;
        d.yApproved = true;
        if (d.xApproved) {
          socket.emit("process-swap", d);
        }
      }

      await storage.set("session-" + sessionId, {
        ...d,
      });
    }
    socket.to(sessionId).emit("target-nft-approved", {
      contractAddress: data.contractAddress,
      tokenId: data.tokenId,
    });
  });

  socket.to(sessionId).emit("new-participant", {
    address: userAddress,
  });
  const sockets = await socket.in(sessionId).fetchSockets();
  socket.emit("participants", {
    addresses: sockets.map((s) => s.handshake.headers["x-address"]),
  });

  log("socket session id ", sessionId);
  if (sessionId) {
    log("Adding socket ", socket.id, " to room ", sessionId);
    socket.join(sessionId);
  }
}

async function main() {
  const app = express();
  const httpServer = createServer(app);
  const io = new socketio.Server(httpServer, { cors: { origin: "*" } });

  const storage = await kvsMemoryStorage({
    name: "db",
    version: 1,
  });

  io.on("connection", async (socket) => {
    const sessionId = socket.handshake.headers["x-session-id"] as string;
    const userAddress = socket.handshake.headers["x-address"] as string;

    const session = (await storage.get(
      "session-" + sessionId
    )) as unknown as ISession;
    if (!session) {
      log("session %o doesn't exists", sessionId);
      socket.disconnect();
      return;
    }
    const newSession = { ...session };
    if (newSession.xAddr === userAddress || newSession.yAddr == userAddress) {
      //  reconnection
    } else {
      if (newSession.xAddr.length === 0) {
        newSession.xAddr = userAddress;
      } else {
        newSession.yAddr = userAddress;
      }
    }
    await storage.set("session-" + sessionId, newSession);

    await attachHandlers(socket, sessionId, userAddress, storage, io);
  });

  app.use(cors({ origin: "*" }));
  app.post("/create-session", async (req, res) => {
    const id = Buffer.from(randomBytes(3)).toString("hex");
    await storage.set("session-" + id, {
      timestamp: Date.now(),
      xTokenId: "",
      xContractAddr: "",
      xAddr: "",
      yTokenId: "",
      yContractAddr: "",
      yAddr: "",
      xApproved: false,
      yApproved: false,
    } satisfies ISession);
    res.json({ session_id: id });
  });

  app.get("/session/:id", async (req, res) => {
    const sessionId = req.params.id;
    let s = await storage.get("session-" + sessionId);
    console.log(s);
    if (s) {
      return res.status(200).json(s);
    }
    return res.status(404).json({ error: "not-found" });
  });

  const port = process.env.PORT || 6000;
  httpServer.listen(port, () => {
    log("Server listening on port ", port);
  });
}

main().catch((e) => console.error("Program error: ", e));
