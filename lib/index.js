/**
 * This script is the main entry point for scrapping of the Bankin Challenge page.
 * The main purpose of this script is to parse lists of transactions in the challenge page
 * and return them as an array of json objects.
 * The page is paginated it is therefore required to run multiple calls to the url (with page param).
 * To optimize performances, we spawn child processes to parallelize fetching of pages.
 * The number of child processes is determined at start. Child processes do not die after a request.
 * In fact they are kept alive as long as pages can be fetched and this script will feed them with the next request to be performed.
 * When they have finished processing a request, they send back the resulting transactions to this script.
 * When all children report that the page they we asked to process is empty, we can stop and dump the aggregated transactions.
 */
const fork = require('child_process').fork;
const os = require('os');

// this is the child scropt
const program = 'scrapper-process.js';

// this is the base url
const baseUrl='https://web.bankin.com/challenge/index.html?start=';

// determine the number of children to spawn
// we will have at least 3 children when we are running on a single core, otherwise twice the number of cores minus 1
const nbChildren=(os.cpus().length > 1 ? os.cpus().length * 2 - 1: 2);

// global variable to aggregate transactions returnd by child scrappers
const transactions=[];

// global variable with the next "page" to be fectched. 
// in fact it is not a page number but the index of the first transaction in page, pages are 50 transactions long
let nextTransaction=0;

// helper method to send the url to be fetched to child
function sendNextUrl(child) {
    let nextUrl=baseUrl+nextTransaction;
    child.send(JSON.stringify({url: nextUrl}));
    nextTransaction+=50;
}

// spawn children
for (i=0; i<nbChildren; i++) {
    const child = fork( __dirname + '/' + program);
    // register callback function to process return messages from children
    child.on('message', message => {
        const msg=JSON.parse(message);
        switch(msg.topic) {
            case 'ready':
                // child is initialized, it is now ready to process pages
                sendNextUrl(child);
                break;
            case 'data':
                // child sent some data back, agregate it and ask him for another page
                transactions.push.apply(transactions,msg.data);
                sendNextUrl(child);
                break;
            case 'finished':
                // last request sent to child had no data, we don't need this child anymore, kill him.
                child.kill('SIGHUP');
                break;
        }
    });
}

// once all children are killed, this process will exit, we then dump the aggregated transactions
process.on('exit',()=>{
    process.stdout.write(JSON.stringify(transactions)+'\n');
});