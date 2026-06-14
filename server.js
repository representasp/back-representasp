const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

app.post('/api/consulta', async (req, res) => {
    const { user, senha } = req.body;

    if (!user || !senha) {
        return res.status(400).json({ error: 'RA e senha são obrigatórios.' });
    }

    try {
        const browserHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*'
        };

        // PASSO A: Autenticação Primária (SED)
        const loginResponse = await axios.post(
            'https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/credenciais/api/LoginCompletoToken',
            { user, senha },
            {
                headers: {
                    ...browserHeaders,
                    'Ocp-Apim-Subscription-Key': 'd701a2043aa24d7ebb37e9adf60d043b',
                    'X-Product-Name': 'SalaDoFuturo',
                    'Content-Type': 'application/json'
                }
            }
        );

        // CORREÇÃO AQUI: Mapeando a estrutura exata do retorno da SED
        const tokenSED = loginResponse.data.token;
        const dadosUsuario = loginResponse.data.DadosUsuario;

        if (!tokenSED || !dadosUsuario || !dadosUsuario.CD_USUARIO) {
            return res.status(401).json({ error: 'Falha na leitura dos dados de autenticação da SED.' });
        }

        const codigoAluno = dadosUsuario.CD_USUARIO;

        // PASSO B: Troca de Token (IP.TV) - Passando o JWT obtido da SED
        const iptvTokenResponse = await axios.post(
            'https://edusp-api.ip.tv/registration/edusp/token',
            { token: tokenSED },
            {
                headers: {
                    ...browserHeaders,
                    'x-api-realm': 'edusp',
                    'x-api-platform': 'webclient',
                    'Content-Type': 'application/json'
                }
            }
        );

        const auth_token_iptv = iptvTokenResponse.data.auth_token;

        // PASSO C, D e E: Consultas paralelas usando o códigoAluno corrigido
        const [dadosEscolares, pendenciasResponse, avaliacoesResponse] = await Promise.all([
            axios.get(`https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/apihubintegracoes/api/v2/Turma/ListarTurmasPorAluno?codigoAluno=${codigoAluno}`, {
                headers: { ...browserHeaders, 'Ocp-Apim-Subscription-Key': 'd701a2043aa24d7ebb37e9adf60d043b' }
            }),
            axios.get('https://edusp-api.ip.tv/tms/task/todo/count?filter_expired=true', {
                headers: { ...browserHeaders, 'x-api-key': auth_token_iptv }
            }),
            axios.get(`https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/apiboletim/api/Avaliacao/GetAvaliacaoAluno?AlunoId=${codigoAluno}&AnoLetivo=2026`, {
                headers: { ...browserHeaders, 'Ocp-Apim-Subscription-Key': 'd701a2043aa24d7ebb37e9adf60d043b' }
            })
        ]);

        const infoEscola = dadosEscolares.data[0] || {};
        const totalAvaliacoes = Array.isArray(avaliacoesResponse.data) ? avaliacoesResponse.data.length : 0;

        // Retorna tudo consolidado para o seu index.html
        res.json({
            aluno: {
                codigo: codigoAluno,
                escola: infoEscola.NomeEscola || 'Não Informada',
                turma: infoEscola.DescricaoTurma || 'Não Informada'
            },
            indicadores: {
                pendentes: pendenciasResponse.data.todo || 0,
                expiradas: pendenciasResponse.data.expired || 0,
                avaliacoes: totalAvaliacoes,
                redacoes: 0
            }
        });

    } catch (error) {
        console.error('Erro detalhado no BFF:', error.response?.data || error.message);
        res.status(500).json({ 
            error: 'Erro ao processar dados nas plataformas integradas.',
            details: error.response?.data || error.message 
        });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`BFF rodando perfeitamente na porta ${PORT}`));
