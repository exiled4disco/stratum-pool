const express = require('express');
const app = express();
app.use(express.json());
app.post('/newblock', (req, res) => {
    console.log(`New block notification: ${req.body.blockhash}`);
    process.nextTick(() => {
        require('./real-stratum-server').server.bitcoin.emit('newBlock', { blocks: req.body.blockhash });
    });
    res.sendStatus(200);
});
app.listen(3334, '0.0.0.0', () => console.log('Blocknotify server on 3334'));