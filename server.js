import express from 'express';
import cors from 'cors';

const app = express();

// السماح بالاتصال من أي موقع
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

app.use(express.json());

// مسار للتحقق
app.get('/', (req, res) => {
  res.send('AttendX Backend is Active and Connected!');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
