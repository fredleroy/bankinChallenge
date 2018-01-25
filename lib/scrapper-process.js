/**
 * This is the actual scrapper script for bankin challenge page.
 * This script is spawned by the main index.js script.
 * It will first initialize a chromium browser, then tell parent script it is ready to process requests.
 * Once a request is processed, this script will sent back data retrieved to parent or indicate the page was empty.
 * If page is empty, this means we already got all transactions and no more requests are needed.
 * The behaviour of the challenge page is a bit awkward :
 * - Sometimes, the page will report an error. If that's the case, we can use the "generate" button in the page to get the table of data again (it doesn't fail again)
 * - Sometimes the page takes a while to display data. We whall be patient and give it some time, but not too long. There is a tradeoff between abandon & reload vs waiting.
 * - Eventually, the table of transactions is displayed in the page. This can be either a table in dom or an iframe in dom that will contain the actual table...
 */

// use chromium with puppeteer lib
const puppeteer = require('puppeteer');

// regular expression used to parse transactions in table
// make it global so the re is compiled only once. 
const re=/^([a-zA-Z]+)\tTransaction (\d+)\t(\d+)(.)$/

// helper function to initialize a page in browser for our scrapping
// this method registers a callback to dismiss dialogs and keeps track of dismissal :
// when a dialog is presented in page, it is to indicate an error occured.
async function initPage(browser) {
  const page = await browser.newPage();
  page.on('dialog', async dialog => {
    await dialog.dismiss();
    hadError=true;
  });
  // fake a user agent as challenge page seems to have some filtering on this.
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/63.0.3239.132 Safari/537.36').catch(()=>{});
  return page;
}

// main function to get content from a challenge url within a browser page
// challenge website can be very slow to respond and retrying an url can be more efficient than waiting.
// use a timeout for that
async function processUrl(page,url,waitTimeout) {
  // this page should be one initilized with our helper function. It should be able to dismiss error dialogs.
  await page.goto(url); 
  if (hadError) {
    // we dismissed an error dialog, click on button to generate table.
    const btn= await page.$('#btnGenerate');
    await btn.click();
  }
  // now we dismissed potential errors, we should get either a table in dom or an iframe. 
  // The table is added to div with id "dvTable". The iframe has an id "fm". 
  // Wait for the first one to appear.
  // But don't wait too long, if we get a timeout, let the error propagate to caller.
  await Promise.race([
    page.waitForSelector('#dvTable table',{timeout: waitTimeout}),
    page.waitForSelector('#fm',{timeout: waitTimeout})
  ]);
  // Ok we got at least one of table or iframe. Check which and return its content.
  let tableText = await page.evaluate(() => document.querySelector('#dvTable').innerText);
  if (!tableText) {
    const frames=await page.frames();
    const theFrame=frames.find(f => f.name() === 'fm');
    tableText=await theFrame.evaluate(() => document.querySelector('*').innerText);
  }
  return tableText;
}


// helper function to parse the content of the table. 
// If layout of the transaction table changes in the future, update the global RE or this function.
function parseTable(tableText) {
  const [ header, ...lines ]= tableText.split("\n");
  const transactions=lines.filter(s => s.length>0).map(s => {
    const [ wholeLine, Account, Transaction, Amount, Currency ] = re.exec(s);
    return { Account, Transaction, Amount, Currency}
  });
  return transactions;
}

// global variable to track if we dismissed an error dialog.
let hadError=false;

// main function for child process
(async() => {
  // create a browser, make it headless.
  const browser = await puppeteer.launch({headless: true});
  // initialize a page in browser we will use to run queries
  const page=await initPage(browser);
  // Register a call back when parent will instruct us to process an url
  process.on('message', message => {
    (async()=> {
      // get the url we should process
      const msg=JSON.parse(message);
      const url=msg.url;
      // initialise a variable for content of page we fetch on url
      let tableText;
      // let start with a timeout of 20ms.
      let waitTimeout=20;
      // keep trying till we get content
      while (!tableText) { 
        try {
          // reset the error flag
          hadError=false;
          // try to get content from url
          tableText=await processUrl(page,url,waitTimeout);
          // now parse this content
          const transactions=parseTable(tableText);
          if (transactions.length>0) {
            // send data back to parent
            process.send(JSON.stringify({topic: 'data', data: transactions}));
          } else {
            // that page was empty, the url we were provided has gone too far in pagination. We're done.
            // kill browser
            await browser.close();
            // tell parent we don't need to work anymore
            process.send(JSON.stringify({topic: 'finished'}));
          }
        } catch (timeoutError) {
          // got a timeout, let's try again with a little more time (but not more than 100ms)
          if (waitTimeout<100) {
            waitTimeout+=10;
          }
        }
      }
    })();
  });
  
  // Now we're ready to process data, tell parent.
  process.send(JSON.stringify({topic: 'ready'}));
})();
