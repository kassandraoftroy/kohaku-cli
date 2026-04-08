/**
 * Some plugin dependencies stringify objects that contain bigint values.
 * Add a process-wide JSON serializer for bigint so dependency JSON.stringify
 * calls do not throw "Do not know how to serialize a BigInt".
 */
const bigintProto = BigInt.prototype as BigInt & {
  toJSON?: () => string;
};

if (typeof bigintProto.toJSON !== "function") {
  Object.defineProperty(BigInt.prototype, "toJSON", {
    value: function toJSON(this: bigint): string {
      return this.toString();
    },
    writable: true,
    configurable: true,
  });
}
