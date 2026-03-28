class Snowflake {
  constructor(workerId = 1n) {
    this.workerId = BigInt(workerId);
    this.sequence = 0n;
    this.lastTimestamp = 0n;
  }

  timestamp() {
    return BigInt(Date.now());
  }

  nextId() {
    let now = this.timestamp();

    if (now === this.lastTimestamp) {
      this.sequence = (this.sequence + 1n) & 0xFFFn;
      if (this.sequence === 0n) {
        while (now <= this.lastTimestamp) now = this.timestamp();
      }
    } else {
      this.sequence = 0n;
    }

    this.lastTimestamp = now;

    return (
      ((now - 1609459200000n) << 22n) |
      (this.workerId << 12n) |
      this.sequence
    ).toString();
  }
}

export const profileSnowflake = new Snowflake(1n);
export const conversationSnowflake = new Snowflake(2n);
export { Snowflake };
