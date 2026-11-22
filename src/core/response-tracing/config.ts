export interface TraceConfig {readonly maxRecordBytes:number;readonly retentionDays:number;readonly messageRetentionDays:number}
export function traceConfig(input:Pick<TraceConfig,'messageRetentionDays'>&Partial<TraceConfig>):TraceConfig {
 const c={maxRecordBytes:65536,retentionDays:7,...input};
 if(!input||Object.keys(input).some(k=>!['maxRecordBytes','retentionDays','messageRetentionDays'].includes(k))||!Number.isSafeInteger(c.maxRecordBytes)||c.maxRecordBytes<16384||c.maxRecordBytes>1048576||!Number.isSafeInteger(c.retentionDays)||c.retentionDays<=0||!Number.isSafeInteger(c.messageRetentionDays)||c.messageRetentionDays<=c.retentionDays||!Number.isSafeInteger(c.messageRetentionDays*86400000))throw new TypeError('Tracing: invalid_configuration');
 return Object.freeze(c);
}
