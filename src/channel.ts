import { EventEmitter } from 'events';
import { Collection, Db, Document, WithId } from 'mongodb';
import internal from 'stream';

export interface ChannelOptions {
  name?: string;
  mongoDb: Db;
  size?: number;
  max?: number;
}

interface InternalChannelOptions {
  size: number;
  max?: number;
  capped: boolean;
}

export class Channel extends EventEmitter {
  public closed: boolean;
  private options: InternalChannelOptions;
  private listening: boolean | null;
  private name: string;
  private db: Db;
  private collection!: Collection;
  private tailableCursor:  internal.Readable & AsyncIterable<WithId<Document>>;

  constructor(options: ChannelOptions) {
    super();
    // console.log(`new Channel()`, {
    //   options
    // });
    this.db = options.mongoDb;
    this.options = {
      capped: true,
      size: options.size || 100000,
      max: options.max
    };
    // console.log(`this.options`, this.options);
    this.closed = false;
    this.listening = null;
    this.name = options.name || 'mubsub';
    this.setMaxListeners(Infinity);
    this.listen().then(() => {
      // console.log(`Channel.constructor() listen()`, `now listening to pubsub collection`)
    });
  }

  /**
   * Close the channel.
   *
   * @return {Channel} this
   * @api public
   */
  close(): Channel {
    this.closed = true;
    this.tailableCursor.destroy();
    this.removeAllListeners();
    return this;
  }

  async publish(params: { event: string; message: any }) {
    // console.log(`Channel publish()`, params);
    return this.collection.insertOne(params);
  }

  /**
   * Subscribe to an event.
   * If no event is passed - all events are subscribed.
   * @param args
   * @param {string} args.event if no event passed - all events are subscribed.
   * @param {Function} args.callback
   * @return {Object} unsubscribe function
   * @api public
   */
  subscribe({
              event = 'message',
              callback
            }: { event?: string; callback: (data: any) => void }): { unsubscribe: () => void } {
    // console.log(`Channel.subscribe()`, { event });
    this.on(event, callback);
    return {
      unsubscribe: () => {
        this.removeListener(event, callback);
      }
    };
  }

  async latest(latest: Document): Promise<Document> {
    // console.log(`Channel.latest()`, {
    //   collection: !!this.collection,
    //   latest
    // });
    let doc: Document = await this.collection
      .find(latest ? { _id: latest._id } : {})
      .sort({ $natural: -1 })
      .limit(1)
      .next();
    // console.log(`Channel.latest() doc`, doc);
    if (!doc) {
      // console.log(`Channel.latest() no documents found`, `initializing collection`);
      doc = { type: 'init' };
      await this.collection.insertOne(doc);
    }
    return doc;
  }

  async listen(latest?: Document) {
    // console.log(`Channel.listen()`);
    if (!this.collection) {
      await this.init();
    }
    latest = await this.latest(latest);
    // console.log(`Channel.listen()`, `init tailable cursor`);
    this.tailableCursor = this.collection
      .find(
        { _id: { $gt: latest._id } },
        {
          tailable: true,
          awaitData: true,
          sort: { $natural: 1 }
        }
      ).stream();

    this.tailableCursor.on(`data`, (doc: Document) => {
      // console.log(`tailableCursor.on('data')`, doc);
      const { event, message } = doc;
      if (event) {
        // console.log(`Channel.listen() emit event`, doc);
        this.emit(event, message);
        this.emit('message', message);
      }
    });
    this.tailableCursor.on(`error`, (error: any) => {
      console.error(`tailableCursor.on('error')`, error);
      this.emit('cursor-error', error);

    });
    this.tailableCursor.on(`end`, () => {
      // console.log(`tailableCursor.on('end')`, `cursor ended`);
      this.emit('cursor-end');
    });
    this.tailableCursor.on(`close`, () => {
      // console.log(`tailableCursor.on('close')`, `Cursor closed`);
      this.emit('cursor-close');
    });

    this.listening = true;
    this.emit('ready', this.listening);
  }

  private async init(): Promise<Collection> {
    // console.log(`Channel.init()`, { channelName: this.name });
    const collections = await this.db.collections();
    let collection = collections.find((c) => c.collectionName === this.name);
    if (!collection) {
      // console.log(`Channel.init() Creating pubsub collection`, {
      //   name: this.name,
      //   options: this.options
      // });
      collection = await this.db.createCollection(this.name, this.options);
      // console.log(`Channel.init()`, `Successfully created pubsub collection`);
    } else {
      // console.log(`Channel.init()`, `${this.name} collection already exists`);
    }
    this.collection = collection;
    this.emit('collection', this.collection);
    return collection;
  }

  private ready(callback: () => void) {
    // console.log(`Channel.ready()`, { listening: !!this.listening });
    if (this.listening) {
      callback();
    } else {
      this.once('ready', callback);
    }
  }
}
