import axios from 'axios';

const NON_DECLARED_API_URL =
  process.env.NON_DECLARED_API_URL || 'https://a.81club.fun';

export const getNonDeclaredFancies = async (req, res) => {
  try {
    const response = await axios.get(
      `${NON_DECLARED_API_URL}/getNonDeclaredFancies`,
      { params: req.query, timeout: 30000 }
    );
    res.status(response.status).json(response.data);
  } catch (error) {
    const status = error.response?.status || 500;
    const data = error.response?.data || {
      success: false,
      message: error.message || 'Failed to fetch non-declared fancies',
    };
    res.status(status).json(data);
  }
};

export const getNonDeclaredMatches = async (req, res) => {
  try {
    const response = await axios.get(
      `${NON_DECLARED_API_URL}/getNonDeclaredMatches`,
      { params: req.query, timeout: 30000 }
    );
    res.status(response.status).json(response.data);
  } catch (error) {
    const status = error.response?.status || 500;
    const data = error.response?.data || {
      success: false,
      message: error.message || 'Failed to fetch non-declared matches',
    };
    res.status(status).json(data);
  }
};
