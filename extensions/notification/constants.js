const constants = {
    extensionName: 'notification',
    nameFilter: {
        prefix: 'prefix',
        suffix: 'suffix',
    },
    zkBucketNotificationPath: 'bucket-notification',
    bucketNotifConfigPropName: 'notificationConfiguration',
    notificationEventPropName: 'originOp',
    eventTimePropName: 'last-modified',
    zkConfigParentNode: 'config',
    arn: {
        partition: 'scality',
        service: 'bucketnotif',
    },
    authFilesFolder: 'ssl',
    supportedAuthTypes: ['kerberos'],
    deleteEvent: 's3:ObjectRemoved:Delete',
};

module.exports = constants;
