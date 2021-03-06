/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { values, keys } from 'vs/base/common/map';
import { ISyncExtension } from 'vs/platform/userDataSync/common/userDataSync';
import { IExtensionIdentifier } from 'vs/platform/extensions/common/extensions';
import { startsWith } from 'vs/base/common/strings';

export interface IMergeResult {
	added: ISyncExtension[];
	removed: IExtensionIdentifier[];
	updated: ISyncExtension[];
	remote: ISyncExtension[] | null;
}

export function merge(localExtensions: ISyncExtension[], remoteExtensions: ISyncExtension[] | null, lastSyncExtensions: ISyncExtension[] | null, skippedExtensions: ISyncExtension[], ignoredExtensions: string[]): IMergeResult {
	const added: ISyncExtension[] = [];
	const removed: IExtensionIdentifier[] = [];
	const updated: ISyncExtension[] = [];

	if (!remoteExtensions) {
		return {
			added,
			removed,
			updated,
			remote: localExtensions.filter(({ identifier }) => ignoredExtensions.every(id => id.toLowerCase() !== identifier.id.toLowerCase()))
		};
	}

	const uuids: Map<string, string> = new Map<string, string>();
	const addUUID = (identifier: IExtensionIdentifier) => { if (identifier.uuid) { uuids.set(identifier.id.toLowerCase(), identifier.uuid); } };
	localExtensions.forEach(({ identifier }) => addUUID(identifier));
	remoteExtensions.forEach(({ identifier }) => addUUID(identifier));
	if (lastSyncExtensions) {
		lastSyncExtensions.forEach(({ identifier }) => addUUID(identifier));
	}

	const addExtensionToMap = (map: Map<string, ISyncExtension>, extension: ISyncExtension) => {
		const uuid = extension.identifier.uuid || uuids.get(extension.identifier.id.toLowerCase());
		const key = uuid ? `uuid:${uuid}` : `id:${extension.identifier.id.toLowerCase()}`;
		map.set(key, extension);
		return map;
	};
	const localExtensionsMap = localExtensions.reduce(addExtensionToMap, new Map<string, ISyncExtension>());
	const remoteExtensionsMap = remoteExtensions.reduce(addExtensionToMap, new Map<string, ISyncExtension>());
	const newRemoteExtensionsMap = remoteExtensions.reduce(addExtensionToMap, new Map<string, ISyncExtension>());
	const lastSyncExtensionsMap = lastSyncExtensions ? lastSyncExtensions.reduce(addExtensionToMap, new Map<string, ISyncExtension>()) : null;
	const skippedExtensionsMap = skippedExtensions.reduce(addExtensionToMap, new Map<string, ISyncExtension>());
	const ignoredExtensionsSet = ignoredExtensions.reduce((set, id) => {
		const uuid = uuids.get(id.toLowerCase());
		return set.add(uuid ? `uuid:${uuid}` : `id:${id.toLowerCase()}`);
	}, new Set<string>());

	const localToRemote = compare(localExtensionsMap, remoteExtensionsMap, ignoredExtensionsSet);
	if (localToRemote.added.size === 0 && localToRemote.removed.size === 0 && localToRemote.updated.size === 0) {
		// No changes found between local and remote.
		return { added: [], removed: [], updated: [], remote: null };
	}

	const baseToLocal = lastSyncExtensionsMap ? compare(lastSyncExtensionsMap, localExtensionsMap, ignoredExtensionsSet) : { added: keys(localExtensionsMap).reduce((r, k) => { r.add(k); return r; }, new Set<string>()), removed: new Set<string>(), updated: new Set<string>() };
	const baseToRemote = lastSyncExtensionsMap ? compare(lastSyncExtensionsMap, remoteExtensionsMap, ignoredExtensionsSet) : { added: keys(remoteExtensionsMap).reduce((r, k) => { r.add(k); return r; }, new Set<string>()), removed: new Set<string>(), updated: new Set<string>() };

	const massageSyncExtension = (extension: ISyncExtension, key: string): ISyncExtension => {
		const massagedExtension: ISyncExtension = {
			identifier: {
				id: extension.identifier.id,
				uuid: startsWith(key, 'uuid:') ? key.substring('uuid:'.length) : undefined
			},
			enabled: extension.enabled,
		};
		if (extension.version) {
			massagedExtension.version = extension.version;
		}
		return massagedExtension;
	};

	// Remotely removed extension.
	for (const key of values(baseToRemote.removed)) {
		const e = localExtensionsMap.get(key);
		if (e) {
			removed.push(e.identifier);
		}
	}

	// Remotely added extension
	for (const key of values(baseToRemote.added)) {
		// Got added in local
		if (baseToLocal.added.has(key)) {
			// Is different from local to remote
			if (localToRemote.updated.has(key)) {
				updated.push(massageSyncExtension(remoteExtensionsMap.get(key)!, key));
			}
		} else {
			// Add to local
			added.push(massageSyncExtension(remoteExtensionsMap.get(key)!, key));
		}
	}

	// Remotely updated extensions
	for (const key of values(baseToRemote.updated)) {
		// If updated in local
		if (baseToLocal.updated.has(key)) {
			// Is different from local to remote
			if (localToRemote.updated.has(key)) {
				// update it in local
				updated.push(massageSyncExtension(remoteExtensionsMap.get(key)!, key));
			}
		}
	}

	// Locally added extensions
	for (const key of values(baseToLocal.added)) {
		// Not there in remote
		if (!baseToRemote.added.has(key)) {
			newRemoteExtensionsMap.set(key, massageSyncExtension(localExtensionsMap.get(key)!, key));
		}
	}

	// Locally updated extensions
	for (const key of values(baseToLocal.updated)) {
		// If removed in remote
		if (baseToRemote.removed.has(key)) {
			continue;
		}

		// If not updated in remote
		if (!baseToRemote.updated.has(key)) {
			newRemoteExtensionsMap.set(key, massageSyncExtension(localExtensionsMap.get(key)!, key));
		}
	}

	// Locally removed extensions
	for (const key of values(baseToLocal.removed)) {
		// If not skipped and not updated in remote
		if (!skippedExtensionsMap.has(key) && !baseToRemote.updated.has(key)) {
			newRemoteExtensionsMap.delete(key);
		}
	}

	const remoteChanges = compare(remoteExtensionsMap, newRemoteExtensionsMap, new Set<string>());
	const remote = remoteChanges.added.size > 0 || remoteChanges.updated.size > 0 || remoteChanges.removed.size > 0 ? values(newRemoteExtensionsMap) : null;
	return { added, removed, updated, remote };
}

function compare(from: Map<string, ISyncExtension>, to: Map<string, ISyncExtension>, ignoredExtensions: Set<string>): { added: Set<string>, removed: Set<string>, updated: Set<string> } {
	const fromKeys = keys(from).filter(key => !ignoredExtensions.has(key));
	const toKeys = keys(to).filter(key => !ignoredExtensions.has(key));
	const added = toKeys.filter(key => fromKeys.indexOf(key) === -1).reduce((r, key) => { r.add(key); return r; }, new Set<string>());
	const removed = fromKeys.filter(key => toKeys.indexOf(key) === -1).reduce((r, key) => { r.add(key); return r; }, new Set<string>());
	const updated: Set<string> = new Set<string>();

	for (const key of fromKeys) {
		if (removed.has(key)) {
			continue;
		}
		const fromExtension = from.get(key)!;
		const toExtension = to.get(key);
		if (!toExtension
			|| fromExtension.enabled !== toExtension.enabled
			|| fromExtension.version !== toExtension.version
		) {
			updated.add(key);
		}
	}

	return { added, removed, updated };
}
