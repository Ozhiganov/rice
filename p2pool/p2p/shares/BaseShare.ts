import SmallBlockHeader from './Smallblockheader';
import ShareInfo from './Shareinfo';
import { HashLink } from './HashLink';
import BufferReader from '../../../misc/BufferReader';
import * as utils from '../../../misc/Utils';
import BufferWriter from '../../../misc/BufferWriter';
import * as assert from 'assert';
import * as BigNum from 'bignum';
import { bitsToDifficulty, bitsToTarget } from "../../../core/Algos";
import MerkleTree from "../../../core/MerkleTree";
import { Block } from "bitcoinjs-lib";

const DONATION_SCRIPT = Buffer.from('4104ffd03de44a6e11b9917f3a29f9443283d9871c9d743ef30d5eddcd37094b64d1b3d8090496b53256786bf5c82932ec23c3b74d9f05a6f95a8b5529352656664bac', 'hex')
const GENTX_BEFORE_REFHASH = Buffer.concat([BufferWriter.writeVarNumber(DONATION_SCRIPT.length), DONATION_SCRIPT, Buffer.alloc(8, 0), BufferWriter.writeVarString('6a28' + '0000000000000000000000000000000000000000000000000000000000000000' + '0000000000000000', 'hex').slice(0, 3)]);
assert.equal(GENTX_BEFORE_REFHASH.toString('hex'), '434104ffd03de44a6e11b9917f3a29f9443283d9871c9d743ef30d5eddcd37094b64d1b3d8090496b53256786bf5c82932ec23c3b74d9f05a6f95a8b5529352656664bac00000000000000002a6a28');

export abstract class BaseShare {

    // These fileds should be initalized when pool starts
    static SEGWIT_ACTIVATION_VERSION = 0
    static IDENTIFIER: Buffer;
    static PowFunc: (data: Buffer) => Buffer;
    static MAX_TARGET = 0;

    VERSION = 0;
    VOTING_VERSION = 0;
    SUCCESSOR = null;
    MAX_BLOCK_WEIGHT = 4000000;
    MAX_NEW_TXS_SIZE = 50000;

    minHeader: SmallBlockHeader;
    info: ShareInfo;
    refMerkleLink: Buffer[]; // 256 bits list
    lastTxoutNonce: BigNum; // 64 bits
    hashLink: HashLink;
    merkleLink: Buffer[];

    hash: string; // share hash
    previousHash: string; // previous share hash
    newScript: Buffer;
    target: number;
    gentxHash: Buffer;
    newTxHashes: string[];
    validity = false;

    constructor(minHeader: SmallBlockHeader = null, info: ShareInfo = null, hashLink: HashLink = null, merkleLink: Buffer[] = null) {
        this.minHeader = minHeader;
        this.info = info;
        this.hashLink = hashLink;
        this.merkleLink = merkleLink;
    }

    init() {
        let segwitActivated = BaseShare.isSegwitActivated(this.VERSION);

        let n = new Set<number>();
        this.info.extractTransactionHashRefs().forEach(tuple => {
            let { shareCount, txCount } = tuple;
            assert.equal(shareCount < 110, true);
            if (shareCount > 0) return;
            n.add(txCount);
        });
        if (n.size !== this.info.newTransactionHashes.length) return false;

        this.newTxHashes = this.info.newTransactionHashes;
        this.newScript = utils.hash160ToScript(this.info.data.pubkeyHash); // script Pub Key
        this.target = bitsToTarget(this.info.bits);

        this.gentxHash = this.hashLink.check(Buffer.concat([
            BaseShare.getRefHash(this.info, this.refMerkleLink), // the last txout share info which is written in coinbase 
            new BigNum(this.lastTxoutNonce).toBuffer({ endian: 'little', size: 8 }), // last txout nonce
            Buffer.alloc(4, 0) // lock time, 4 bytes
        ]), GENTX_BEFORE_REFHASH);

        let merkleRoot = (segwitActivated && this.info.segwit.txidMerkleLink.branch ? this.info.segwit.txidMerkleLink.branch : this.merkleLink).aggregate(this.gentxHash, (c, n) => utils.sha256d(Buffer.concat([c, n])));
        let headerHash = this.minHeader.calculateHash(merkleRoot);
        this.hash = utils.hexFromReversedBuffer(headerHash);
        this.previousHash = this.info.data.previousShareHash;
        
        if (this.target > BaseShare.MAX_TARGET) return false;
        if (BigNum.fromBuffer(BaseShare.PowFunc(this.minHeader.buildHeader(merkleRoot)), { endian: 'little', size: 32 }).toNumber() > this.target) return false;

        this.validity = true;
        return true;
    }

    toBuffer(): Buffer {
        return Buffer.concat([
            this.minHeader.toBuffer(),
            this.info.toBuffer(),
            BufferWriter.writeList(this.refMerkleLink),
            this.lastTxoutNonce.toBuffer({ endian: 'little', size: 8 }),
            this.hashLink.toBuffer(),
            BufferWriter.writeList(this.merkleLink)
        ]);
    }


    static fromBufferReader(version: number, reader: BufferReader) {
        let constructor = ShareVersionMapper[version];
        if (!constructor) return null;
        let share = new constructor() as BaseShare;
        share.minHeader = SmallBlockHeader.fromBufferReader(reader);
        share.info = ShareInfo.fromBufferReader(reader, BaseShare.isSegwitActivated(share.VERSION));
        share.refMerkleLink = reader.readList(32);
        share.lastTxoutNonce = reader.readNumber(8);
        share.hashLink = HashLink.fromBufferReader(reader);
        share.merkleLink = reader.readList(32);
        share.init();
        return share;
    }

    static isSegwitActivated(version: number) {
        return version >= BaseShare.SEGWIT_ACTIVATION_VERSION && BaseShare.SEGWIT_ACTIVATION_VERSION > 0
    }

    static getRefHash(shareInfo: ShareInfo, refMerkleLink: Buffer[]) {
        let ref = Buffer.concat([BaseShare.IDENTIFIER, shareInfo.toBuffer()]);
        return refMerkleLink.aggregate(utils.sha256d(ref), (c, n) => utils.sha256d(Buffer.concat([c, n])));
    }
}

export class Share extends BaseShare {
    static readonly VERSION = 16;
    static readonly VOTING_VERSION = 16;
    readonly SUCCESSOR = NewShare;

    constructor() {
        super();
        super.VERSION = Share.VERSION;
        super.VOTING_VERSION = Share.VOTING_VERSION;
    }
}

export class NewShare extends BaseShare {
    static readonly VERSION = 17;
    readonly VOTING_VERSION = 17;
    readonly MAX_NEW_TXS_SIZE = 100000;

    constructor() {
        super();
        super.VERSION = NewShare.VERSION;
    }
}

const ShareVersionMapper = { 16: Share, 17: NewShare };


