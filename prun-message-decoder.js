const ENGINE_IO_PACKET_TYPE = {
  0: 'open',
  1: 'close',
  2: 'ping',
  3: 'pong',
  4: 'message', // This is the type we are interested in
  5: 'upgrade',
  6: 'noop',
};

const ENGINE_IO_SEPARATOR = String.fromCharCode(30); // ASCII Record Separator

/**
 * Decodes an Engine.IO payload into individual packets.
 * @param {string} encodedPayload - The raw Engine.IO payload string.
 * @returns {Array<Object>} An array of decoded Engine.IO packets.
 */
function decodeEngineIOPayload(encodedPayload) {
  const encodedPackets = encodedPayload.split(ENGINE_IO_SEPARATOR);
  const packets = [];
  for (let i = 0; i < encodedPackets.length; i++) {
    const encodedPacket = encodedPackets[i];
    if (!encodedPacket) continue; // Skip empty strings from split

    const typeChar = encodedPacket.charAt(0);
    const type = Number(typeChar);
    const data = encodedPacket.substring(1);

    if (ENGINE_IO_PACKET_TYPE[type] === 'message') {
      packets.push({ type: 'message', data: data });
    } else {
      packets.push({ type: ENGINE_IO_PACKET_TYPE[type] || 'unknown', data: data });
    }
  }
  return packets;
}

const SOCKET_IO_PACKET_TYPE = {
  EVENT: 2, // This is the type for standard Socket.IO events
};

/**
 * Decodes a Socket.IO packet string.
 * @param {string} encodedPacket - The raw Socket.IO packet string.
 * @returns {Object | undefined} The decoded Socket.IO packet object, or undefined if parsing fails.
 */
function decodeSocketIOPacket(encodedPacket) {
  try {
    let i = 0;
    const packetType = Number(encodedPacket.charAt(0));

    // We are primarily interested in EVENT packets (type 2)
    if (packetType !== SOCKET_IO_PACKET_TYPE.EVENT) {
      return undefined;
    }

    // Skip packet type char
    i++;

    // Look for namespace For PrUn, it's '/'
    if (encodedPacket.charAt(i) === '/') {
      const nspStart = i;
      while (i < encodedPacket.length && encodedPacket.charAt(i) !== ',') {
        i++;
      }
      if (encodedPacket.charAt(i) === ',') {
        i++; // Skip the comma if present
      }
    }

    // Look for id (optional, numeric)
    const nextChar = encodedPacket.charAt(i);
    if (nextChar !== '' && !isNaN(Number(nextChar))) {
      const idStart = i;
      while (i < encodedPacket.length && !isNaN(Number(encodedPacket.charAt(i)))) {
        i++;
      }
    }

    // The rest is the JSON data
    const jsonDataString = encodedPacket.substring(i);
    const data = JSON.parse(jsonDataString);

    // For PrUn, the actual message payload is usually the second element of the array
    // if the first is the event name (e.g., ["event_name", { ...payload... }])
    if (Array.isArray(data) && data.length >= 2) {
      return {
        type: packetType,
        eventName: data[0],
        payload: data[1] // This is the "good JSON object"
      };
    }

    return undefined; // If not the expected array format
  } catch (e) {
    console.error('[PrUn Decoder] Error decoding Socket.IO packet:', e, encodedPacket);
    return undefined;
  }
}

/**
 * Takes a raw WebSocket message string and attempts to extract the PrUn JSON payload.
 * This function is now attached to the window object for global access.
 * @param {string} rawMessage - The raw WebSocket message data.
 * @returns {Object | undefined} The extracted PrUn JSON object, or undefined if not found/parsed.
 */
window.getPrunMessagePayload = function(rawMessage) {
  if (typeof rawMessage !== 'string') {
    return undefined;
  }

  const engineIOPackets = decodeEngineIOPayload(rawMessage);
  for (const engineIOPacket of engineIOPackets) {
    if (engineIOPacket.type === 'message' && engineIOPacket.data) {
      const socketIOPacket = decodeSocketIOPacket(engineIOPacket.data);
      if (socketIOPacket && socketIOPacket.type === SOCKET_IO_PACKET_TYPE.EVENT) {
        return socketIOPacket.payload;
      }
    }
  }
  return undefined;
};
