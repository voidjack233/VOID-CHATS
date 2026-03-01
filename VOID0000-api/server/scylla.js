// server/scylla.js
import cassandra from 'cassandra-driver';

const client = new cassandra.Client({
  contactPoints: [process.env.SCYLLA_HOST || '127.0.0.1'],
  localDataCenter: 'datacenter1',
  keyspace: 'voidapp',
  pooling: {
    coreConnectionsPerHost: {
      [cassandra.types.distance.local]: 2,
      [cassandra.types.distance.remote]: 1,
    },
  },
});

client.connect()
  .then(() => console.log('✅ ScyllaDB connected'))
  .catch((err) => console.error('❌ ScyllaDB connection error:', err.message));

// Helper: generate TimeUUID for message IDs
export function generateTimeUUID() {
  return cassandra.types.TimeUuid.now();
}

// Helper: convert TimeUUID to Date
export function timeUUIDToDate(timeUuid) {
  return timeUuid.getDate();
}

// Helper: TimeUUID from date (for pagination)
export function timeUUIDFromDate(date) {
  return cassandra.types.TimeUuid.fromDate(date);
}

export { cassandra };
export default client;