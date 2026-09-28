/** A response whose body was read as text; `response` itself is left unread. */
export interface Raw {
  readonly response: Response;
  readonly text: string;
}

/** Parsed data with the HTTP response it came from. */
export interface WithResponse<T> {
  data: T;
  /** Its body is unread. */
  response: Response;
  /** From `x-request-id`. */
  requestId: string | undefined;
}

/**
 * A request's parsed result, with the HTTP response one call away.
 *
 * Awaiting it parses once; `withResponse()` adds the response and request id, `asResponse()` skips parsing.
 * A status outside 2xx rejects every path with an `APIError`.
 */
export class APIPromise<T> extends Promise<T> {
  readonly #raw: Promise<Raw>;
  readonly #read: (raw: Raw) => T;
  #data: Promise<T> | undefined;

  constructor(raw: Promise<Raw>, read: (raw: Raw) => T) {
    // Settles to nothing; every consumer goes through the overridden then/catch/finally.
    super((resolve) => resolve(undefined as T));
    this.#raw = raw;
    this.#read = read;
  }

  static override get [Symbol.species](): PromiseConstructor {
    return Promise;
  }

  /** The HTTP response, its body unread. */
  asResponse(): Promise<Response> {
    return this.#raw.then((raw) => raw.response);
  }

  /** The parsed data, the HTTP response and its request id. */
  async withResponse(): Promise<WithResponse<T>> {
    const [data, raw] = await Promise.all([this.#parsed(), this.#raw]);
    return { data, response: raw.response, requestId: raw.response.headers.get("x-request-id") ?? undefined };
  }

  #parsed(): Promise<T> {
    this.#data ??= this.#raw.then(this.#read);
    return this.#data;
  }

  override then<A = T, B = never>(
    fulfilled?: ((value: T) => A | PromiseLike<A>) | null,
    rejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return this.#parsed().then(fulfilled, rejected);
  }

  override catch<B = never>(rejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<T | B> {
    return this.#parsed().catch(rejected);
  }

  override finally(done?: (() => void) | null): Promise<T> {
    return this.#parsed().finally(done);
  }
}
