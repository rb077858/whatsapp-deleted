// Reads WhatsApp's app-state ("syncd") collections directly, to see the user's chat lists
// exactly as the phone stores them. Baileys replays these only once, at first link.
// Approach adapted from omarchy-whatsapp (MIT, daemon/lib/appstate.js): full snapshot plus
// trailing patches, decoded read-only and per record, skipping records we have no key for.
import { aesDecrypt, downloadExternalPatch, extractSyncdPatches, hkdf, proto, S_WHATSAPP_NET } from 'baileys'

const COLLECTIONS = ['regular_high', 'regular', 'regular_low']
const REMOVE = proto.SyncdMutation.SyncdOperation.REMOVE
export const LIST_TYPES = Object.fromEntries(Object.entries(proto.SyncActionValue.LabelEditAction.ListType).map(([k, v]) => [v, k]))

const toNum = v => (v == null ? 0 : typeof v === 'number' ? v : typeof v.toNumber === 'function' ? v.toNumber() : Number(v) || 0)

async function decodeRecords (mutations, getKey, onMutation, collection) {
  const keyCache = new Map()
  let skipped = 0
  for (const entry of mutations) {
    const operation = 'operation' in entry ? entry.operation : 0
    const record = 'record' in entry && entry.record ? entry.record : entry
    try {
      const keyId = Buffer.from(record.keyId.id).toString('base64')
      if (!keyCache.has(keyId)) {
        const stored = await getKey(keyId)
        // bytes 32..64 of the expanded key are the value-encryption key
        keyCache.set(keyId, stored ? Buffer.from(hkdf(stored.keyData, 160, { info: 'WhatsApp Mutation Keys' })).subarray(32, 64) : null)
      }
      const valueKey = keyCache.get(keyId)
      if (!valueKey) { skipped++; continue }
      const blob = Buffer.from(record.value.blob)
      const action = proto.SyncActionData.decode(aesDecrypt(blob.slice(0, -32), valueKey))
      onMutation({ action, index: JSON.parse(Buffer.from(action.index).toString()), removed: operation === REMOVE, collection })
    } catch {
      skipped++
    }
  }
  return skipped
}

async function readCollection (sock, name, getKey, onMutation) {
  let version = 0
  let skipped = 0
  for (let round = 0; round < 20; round++) {
    const result = await sock.query({
      tag: 'iq',
      attrs: { to: S_WHATSAPP_NET, xmlns: 'w:sync:app:state', type: 'set' },
      content: [{ tag: 'sync', attrs: {}, content: [{ tag: 'collection', attrs: { name, version: String(version), return_snapshot: String(!version) } }] }]
    })
    const decoded = (await extractSyncdPatches(result))[name]
    if (!decoded) break
    const { patches, hasMorePatches, snapshot } = decoded
    if (snapshot) {
      version = toNum(snapshot.version?.version)
      skipped += await decodeRecords(snapshot.records || [], getKey, onMutation, name)
    }
    for (const patch of patches) {
      const mutations = patch.mutations || []
      if (patch.externalMutations) mutations.push(...(await downloadExternalPatch(patch.externalMutations)).mutations)
      skipped += await decodeRecords(mutations, getKey, onMutation, name)
      version = Math.max(version, toNum(patch.version?.version))
    }
    if (!hasMorePatches) break
  }
  return skipped
}

/**
 * Everything WhatsApp knows about the user's chat lists: each list with its raw fields,
 * the chats in it, and the list-order record (labelReorderingAction).
 */
export async function scanLists (sock, keys) {
  const getKey = async id => (await keys.get('app-state-sync-key', [id]))[id]
  const lists = new Map()
  const members = new Map()
  let order = null
  const onMutation = ({ action, index, removed, collection }) => {
    const value = action.value
    if (!value || !Array.isArray(index)) return
    if (value.labelEditAction) {
      const e = value.labelEditAction
      lists.set(String(index[1]), {
        id: String(index[1]),
        name: e.name || '',
        type: LIST_TYPES[e.type || 0] || e.type,
        orderIndex: e.orderIndex ?? null,
        isActive: e.isActive ?? null,
        isImmutable: e.isImmutable ?? null,
        predefinedId: e.predefinedId ?? null,
        color: e.color ?? null,
        deleted: !!e.deleted || removed,
        collection,
        index,
        apiVersion: action.version
      })
    } else if (value.labelAssociationAction && index[0] === 'label_jid') {
      const id = String(index[1])
      if (!members.has(id)) members.set(id, new Set())
      if (!removed && value.labelAssociationAction.labeled) members.get(id).add(index[2])
      else members.get(id).delete(index[2])
    } else if (value.labelReorderingAction) {
      order = { ids: (value.labelReorderingAction.sortedLabelIds || []).map(String), collection, index, apiVersion: action.version }
    }
  }
  const errors = {}
  let skipped = 0
  for (const name of COLLECTIONS) {
    try { skipped += await readCollection(sock, name, getKey, onMutation) } catch (e) { errors[name] = e.message }
  }
  return {
    lists: [...lists.values()].map(l => ({ ...l, members: [...(members.get(l.id) || [])] })),
    order,
    skipped,
    errors
  }
}
